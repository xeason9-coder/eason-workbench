"""Session renewal checks use fake responses and never contact WeRead."""
import unittest
from unittest.mock import Mock, patch

import requests
from core.wx.model.weread import MpsWeread
from core.wx.model.weread_mp import WereadMPAPIError
from driver.weread_qr import WereadQRLogin, WEREAD_USER_AGENT


class WereadSessionTests(unittest.TestCase):
    def login(self):
        login = object.__new__(WereadQRLogin)
        login._session = Mock(headers={"User-Agent": WEREAD_USER_AGENT})
        login._logged_in = False
        return login

    def response(self, payload, cookies=None):
        response = Mock(status_code=200)
        response.json.return_value = payload
        response.cookies = requests.cookies.cookiejar_from_dict(cookies or {})
        return response

    def test_old_cookie_in_request_jar_is_not_a_successful_renewal(self):
        old = {"wr_vid":"123", "wr_skey":"expired", "wr_rt":"refresh"}
        with patch("driver.weread_qr.requests.Session") as factory:
            session = factory.return_value
            session.headers = {}
            session.cookies = requests.cookies.cookiejar_from_dict(old)
            session.post.return_value = self.response({"errCode":0})
            self.assertIsNone(self.login()._renew_cookie(old))
            session.post.assert_called_once()
            session.post.return_value = self.response({"errCode":-2013}, {"wr_skey":"untrusted"})
            self.assertIsNone(self.login()._renew_cookie(old))
            session.post.return_value = self.response({"errCode":0}, {"wr_skey":"fresh", "wr_rt":"rotated"})
            result = self.login()._renew_cookie(old)
            self.assertEqual(result, {"wr_vid":"123", "wr_skey":"fresh", "wr_rt":"rotated"})

    def test_save_keeps_validated_session_and_refresh_token_together(self):
        login = self.login()
        login._build_cookie_dict = Mock(return_value={"wr_vid":"123", "wr_skey":"old", "wr_rt":"old-rt", "wr_fp":"fp"})
        login._verify_cookies = Mock(return_value=True)
        with patch("core.config.Config") as config:
            config.return_value.get.return_value = {"accounts":[{"vid":"123", "cookie":"old", "name":"name", "ticket":"keep"}]}
            self.assertTrue(login._save_cookies_to_lic({"vid":"123", "wr_skey":"fresh",
                "cookies":{"wr_vid":"123", "wr_skey":"fresh", "wr_rt":"fresh-rt"}}))
            saved = config.return_value.set.call_args.args[1]["accounts"][0]
            self.assertIn("wr_rt=fresh-rt", saved["cookie"])
            self.assertIn("wr_fp=fp", saved["cookie"])
            self.assertEqual(saved["ticket"], "keep")
            self.assertNotIn("old-rt", saved["cookie"])

    def test_failed_save_never_reports_login_success(self):
        login = self.login()
        login._check_login_status = Mock(return_value={"succeed":True, "vid":"123"})
        login._build_cookie_dict = Mock(return_value={"wr_vid":"123", "wr_skey":"fresh"})
        login._build_cookie_candidates = Mock(return_value=[{"wr_vid":"123", "wr_skey":"fresh"}])
        login._verify_cookies = Mock(return_value=True)
        login._save_cookies_to_lic = Mock(return_value=False)
        callback = Mock()
        login._poll_once(callback)
        self.assertFalse(login._logged_in)
        callback.assert_not_called()

    def collector(self):
        collector = object.__new__(MpsWeread)
        collector._weread_cookies = "old"
        collector._weread_ticket = ""
        collector._weread_vid = "123"
        collector._get_proxies = Mock(return_value=None)
        collector._renew_saved_session = Mock(return_value="fresh")
        collector._persist_renewed_session = Mock()
        return collector

    def test_login_expiry_renews_once_retries_same_request_then_saves(self):
        collector = self.collector()
        with patch("requests.get", side_effect=[self.response({"errCode":-2012}), self.response({"books":[]})]) as get:
            collector._weread_http_get("https://weread.qq.com/web/shelf/sync", {"userVid":""})
            self.assertEqual(get.call_count, 2)
            self.assertEqual(get.call_args.kwargs["headers"]["Cookie"], "fresh")
            self.assertEqual(get.call_args.args[0], "https://weread.qq.com/web/shelf/sync")
        collector._renew_saved_session.assert_called_once()
        collector._persist_renewed_session.assert_called_once_with("old")

    def test_repeated_expiry_stops_and_does_not_save(self):
        collector = self.collector()
        with patch("requests.get", return_value=self.response({"errCode":-2012})) as get:
            with self.assertRaises(WereadMPAPIError):
                collector._weread_http_get("https://weread.qq.com/web/mp/articles")
            self.assertEqual(get.call_count, 2)
        collector._renew_saved_session.assert_called_once()
        collector._persist_renewed_session.assert_not_called()
        self.assertEqual(collector._weread_cookies, "old")

    def test_access_restriction_never_renews_or_retries(self):
        collector = self.collector()
        with patch("requests.get", return_value=self.response({"errCode":-2041})) as get:
            with self.assertRaises(WereadMPAPIError):
                collector._weread_http_get("https://weread.qq.com/web/mp/articles")
            get.assert_called_once()
        collector._renew_saved_session.assert_not_called()

    def test_failed_renewal_is_not_repeated_between_shelf_and_articles(self):
        collector = self.collector()
        collector._renew_saved_session.return_value = None
        with patch("requests.get", return_value=self.response({"errCode":-2012})):
            for path in ("/web/shelf/sync", "/web/mp/articles"):
                with self.assertRaises(WereadMPAPIError):
                    collector._weread_http_get("https://weread.qq.com" + path)
        collector._renew_saved_session.assert_called_once()

    def test_renewal_never_overwrites_a_newer_manual_login(self):
        collector = self.collector()
        with patch("core.config.Config") as config:
            config.return_value.get.return_value = {"accounts":[{"vid":"123", "cookie":"newer-login"}]}
            MpsWeread._persist_renewed_session(collector, "old")
            config.return_value.set.assert_not_called()


if __name__ == "__main__":
    unittest.main()
