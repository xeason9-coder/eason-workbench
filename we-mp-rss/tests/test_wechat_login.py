"""Offline login checks: no browser process or website request is started."""
import os
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from driver.playwright_driver import PlaywrightController
from driver.wx import Wx


class WechatLoginTests(unittest.IsolatedAsyncioTestCase):
    async def test_forced_engine_uses_optional_chrome_path_without_unbound_variable(self):
        for engine, path in (("chromium", None), ("chromium", "/test/chrome"), ("webkit", "/test/chrome")):
            with self.subTest(engine=engine, path=path):
                controller = PlaywrightController(apply_anti_crawler=False)
                context = SimpleNamespace(new_page=AsyncMock(return_value=Mock()))
                browser = SimpleNamespace(new_context=AsyncMock(return_value=context))
                launcher = SimpleNamespace(launch=AsyncMock(return_value=browser))
                playwright = SimpleNamespace(**{engine: launcher})
                with patch("playwright.async_api.async_playwright") as factory, \
                        patch("driver.playwright_driver.get_chrome_executable_path", return_value=path), \
                        patch.dict(os.environ, {"BROWSER_TYPE": engine}):
                    factory.return_value.start = AsyncMock(return_value=playwright)
                    await controller.start_browser()
                self.assertEqual(controller.browser_type, engine)
                self.assertEqual(launcher.launch.await_args.kwargs.get("executable_path"), path if engine == "chromium" else None)

    async def test_login_uses_unmodified_requests_and_keeps_browser_security_defaults(self):
        for enabled in (False, True):
            with self.subTest(collector_injection=enabled):
                controller = PlaywrightController(apply_anti_crawler=enabled)
                controller.anti_crawler_config.get_anti_crawler_config = Mock(return_value={
                    "extra_http_headers": {"Sec-Fetch-Mode": "navigate"},
                    "ignore_https_errors": True, "bypass_csp": True,
                    "java_script_enabled": True,
                })
                controller._apply_anti_crawler_scripts = AsyncMock()
                context = SimpleNamespace(new_page=AsyncMock(return_value=Mock()))
                browser = SimpleNamespace(new_context=AsyncMock(return_value=context))
                launcher = SimpleNamespace(launch=AsyncMock(return_value=browser))
                playwright = SimpleNamespace(webkit=launcher)
                with patch("playwright.async_api.async_playwright") as factory, \
                        patch("driver.playwright_driver.get_chrome_executable_path", return_value=None), \
                        patch.dict(os.environ, {"BROWSER_TYPE": ""}):
                    factory.return_value.start = AsyncMock(return_value=playwright)
                    await controller.start_browser()
                options = browser.new_context.await_args.kwargs
                for key in ("extra_http_headers", "ignore_https_errors", "bypass_csp"):
                    self.assertEqual(key in options, enabled)
                self.assertEqual(controller._apply_anti_crawler_scripts.await_count, int(enabled))
                self.assertTrue(options["java_script_enabled"])

    async def test_qr_login_selects_plain_configuration_before_opening_page(self):
        wx = Wx.__new__(Wx)
        wx._login_lock = threading.Lock()
        wx._qr_task_lock = threading.Lock()
        for method in ("set_lock", "cleanup_resources", "release_lock", "Clean"):
            setattr(wx, method, Mock())
        wx._wait_qrcode_ready = AsyncMock(return_value=False)
        wx.Close = AsyncMock()
        with patch("driver.wx.PlaywrightController") as constructor:
            controller = constructor.return_value
            controller.start_browser = AsyncMock()
            controller.open_url = AsyncMock()
            controller.page.wait_for_load_state = AsyncMock()
            await wx.wxLogin()
            constructor.assert_called_once_with(apply_anti_crawler=False)
            controller.open_url.assert_awaited_once_with(wx.WX_LOGIN)
            wx.Close.assert_awaited_once()
            self.assertIsNone(wx.SESSION)
            self.assertFalse(wx.HasLogin())
            self.assertFalse(wx.check_lock())

    async def test_busy_direct_login_does_not_clean_or_close_running_task(self):
        wx = Wx.__new__(Wx)
        wx._qr_task_lock = threading.Lock()
        wx._qr_task_lock.acquire()
        wx.Clean = Mock()
        wx.Close = AsyncMock()
        try:
            self.assertIsNone(await wx.wxLogin())
            self.assertTrue(wx.check_lock())
            wx.Clean.assert_not_called()
            wx.Close.assert_not_awaited()
        finally:
            wx._qr_task_lock.release()


class QrTaskStateTests(unittest.TestCase):
    def setUp(self):
        self.wx = Wx.__new__(Wx)
        self.wx._login_lock = threading.Lock()
        self.wx._qr_task_lock = threading.Lock()
        self.wx.Clean = Mock()
        self.wx.GetHasCode = Mock(return_value=False)

    def test_reserved_before_thread_starts_and_duplicate_requests_reuse_job(self):
        from concurrent.futures import ThreadPoolExecutor
        wx = self.wx
        wx._haslogin = True
        wx.wxLogin = AsyncMock()
        first_notice = Mock()
        with patch("core.thread.ThreadManager") as factory:
            wx.GetCode(Notice=first_notice)
            self.assertTrue(wx.check_lock())
            self.assertFalse(wx.GetHasCode())
            self.assertFalse(wx.HasLogin())
            with ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(lambda _: wx.GetCode(Notice=Mock()), range(12)))
            factory.assert_called_once()
            wx.Clean.assert_called_once()
            self.assertIs(wx.Notice, first_notice)
            wx.GetHasCode.return_value = True
            self.assertTrue(wx.check_lock())  # Waiting for scan still owns the task.
            factory.call_args.kwargs["target"]()
            self.assertFalse(wx.check_lock())
            wx.wxLogin.assert_awaited_once_with(None, True, _task_reserved=True)

    def test_task_error_and_thread_start_failure_both_allow_retry(self):
        wx = self.wx
        wx.wxLogin = AsyncMock(side_effect=RuntimeError("synthetic task failure"))
        with patch("core.thread.ThreadManager") as factory:
            wx.GetCode()
            with self.assertRaisesRegex(RuntimeError, "synthetic task failure"):
                factory.call_args.kwargs["target"]()
            self.assertFalse(wx.check_lock())
            factory.return_value.start.side_effect = RuntimeError("synthetic dispatch failure")
            with self.assertRaisesRegex(RuntimeError, "synthetic dispatch failure"):
                wx.GetCode()
            self.assertFalse(wx.check_lock())
            factory.return_value.start.side_effect = None
            wx.wxLogin.side_effect = None
            wx.GetCode()
            factory.call_args.kwargs["target"]()
            self.assertFalse(wx.check_lock())


if __name__ == "__main__":
    unittest.main()
