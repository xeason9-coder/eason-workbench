import asyncio
import csv
import io
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from apis.workbench import router
from core import workbench as desk
from core import workbench_auth as auth
from core.models import Article, Feed
from core.models.base import DATA_STATUS


class WorkbenchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.engine = create_engine("sqlite:///" + str(Path(self.tmp.name) / "test.db"),
                                    connect_args={"check_same_thread": False})
        self.addCleanup(self.engine.dispose)
        environment = patch.dict(os.environ, {"EASON_PUBLIC_ORIGIN": "", "EASON_USER_AI_MIN_INTERVAL": "0", "DEEPSEEK_API_KEY": ""})
        environment.start()
        self.addCleanup(environment.stop)
        previous_engine = auth._engine
        self.addCleanup(setattr, auth, "_engine", previous_engine)
        auth.init_auth_tables(self.engine)
        self.user = auth.upsert_user("tester", "test-only-password", "admin")
        for table in (Article.__table__, Feed.__table__, desk.Client.__table__,
                      desk.Source.__table__, desk.Selection.__table__, desk.SyncRun.__table__, desk.ArticleTopics.__table__):
            table.create(self.engine)
        self.factory = sessionmaker(self.engine, expire_on_commit=False)
        for obj, attr, value in [(desk, "Session", self.factory),
                                 (desk, "SETTINGS", Path(self.tmp.name) / "settings.json")]:
            p = patch.object(obj, attr, value)
            p.start()
            self.addCleanup(p.stop)
        now = int(time.time())
        with self.factory.begin() as db:
            db.add_all([
                desk.Client(id="a", owner_id=self.user.id, name="甲客户", archived=False),
                desk.Client(id="b", owner_id=self.user.id, name="乙客户", archived=False),
                Feed(id="MP_WXS_123456", mp_name="来源甲"),
                Feed(id="MP_WXS_654321", mp_name="来源乙"),
                desk.Source(client_id="a", feed_id="MP_WXS_123456", category="行业"),
                desk.Source(client_id="b", feed_id="MP_WXS_654321", category="机构"),
                Article(id="a1", mp_id="MP_WXS_123456", title="PMP 项目管理",
                        content="<style>not searchable text</style><p>项目风险实践</p>",
                        publish_time=now-100, status=1, url="https://mp.weixin.qq.com/s?mid=1"),
                Article(id="a-old", mp_id="MP_WXS_123456", title="旧 PMP",
                        content="<p>历史</p>", publish_time=now-9*86400, status=1),
                Article(id="a-future", mp_id="MP_WXS_123456", title="未来",
                        content="future", publish_time=now+86400, status=1),
                Article(id="a-deleted", mp_id="MP_WXS_123456", title="已排除的推广",
                        content="广告", publish_time=now-50, status=DATA_STATUS.DELETED),
                Article(id="b1", mp_id="MP_WXS_654321", title="PMP 另一个客户",
                        content="乙方专属", publish_time=now-10, status=1),
            ])
        app = FastAPI()
        app.include_router(router)
        app.include_router(auth.router)
        self.http = TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 12345))
        self.addCleanup(self.http.close)
        self.headers = {"X-Workbench": "1", "Origin": "http://127.0.0.1"}
        self.assertEqual(self.http.post("/workbench/api/auth/login", headers=self.headers,
            json={"username": "tester", "password": "test-only-password"}).status_code, 200)

    def test_client_scope_dates_and_soft_deletes(self):
        result = desk.articles("a", user=self.user)
        self.assertEqual([a["id"] for a in result["items"]], ["a1"])
        self.assertEqual(desk.articles("b", user=self.user)["items"][0]["id"], "b1")
        self.assertNotIn("a-deleted", [a["id"] for a in desk.articles("a", days=0, user=self.user)["items"]])
        with self.assertRaises(ValueError):
            desk.article_detail("b", "a1", user=self.user)
        with self.assertRaises(ValueError):
            desk.articles("unknown", user=self.user)

    def test_literal_search_and_plain_text(self):
        self.assertEqual(desk.articles("a", q="%", user=self.user)["total"], 0)
        self.assertEqual(desk.articles("a", q="_", user=self.user)["total"], 0)
        self.assertEqual(desk.articles("a", q="PMP 项目", user=self.user)["total"], 1)
        self.assertEqual(desk.article_detail("a", "a1", user=self.user)["content"], "项目风险实践")
        self.assertIsNone(desk.article_detail("a", "a1", user=self.user)["reading_count"])

    def test_recommended_links_do_not_pollute_search_and_titles_rank_first(self):
        with self.factory.begin() as db:
            db.add(Article(id="footer", mp_id="MP_WXS_123456", title="普通职场话题",
                           content="<p>" + "普通内容" * 80 + "</p><p>近期热文</p><p>PMP 认证大全</p>",
                           publish_time=int(time.time())-20, status=1))
            db.add(Article(id="mention", mp_id="MP_WXS_123456", title="职业发展",
                           content="<p>顺便提及 PMP</p>", publish_time=int(time.time())-30, status=1))
        result = desk.articles("a", q="PMP", user=self.user)
        self.assertEqual([a["id"] for a in result["items"]], ["a1", "mention"])
        self.assertEqual([a["match_type"] for a in result["items"]], ["标题命中", "正文命中"])
        self.assertEqual(len(list(csv.reader(io.StringIO(desk.export_csv("a", q="PMP", user=self.user))))), 3)
        middle = "开头" * 110 + "\n推荐阅读\nPMP 是本文主题\n" + "正文" * 1000
        self.assertIn("PMP", desk.searchable_body(middle))

    def test_shared_source_has_separate_client_selections(self):
        with self.factory.begin() as db:
            db.add(desk.Source(client_id="b", feed_id="MP_WXS_123456"))
        response = self.http.put("/workbench/api/article?client_id=a&article_id=a1",
            headers=self.headers, json={"favorite": True, "hidden": True, "keywords": ["自定义词"]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(desk.articles("a", user=self.user)["total"], 0)
        self.assertEqual(desk.articles("a", view="excluded", user=self.user)["total"], 1)
        self.assertFalse(desk.article_detail("b", "a1", user=self.user)["favorite"])
        self.assertNotIn("自定义词", desk.article_detail("b", "a1", user=self.user)["keywords"])
        self.http.put("/workbench/api/article?client_id=a&article_id=a1",
                      headers=self.headers, json={"hidden": False})
        self.assertEqual(desk.articles("a", view="favorites", user=self.user)["total"], 1)

    def test_client_and_source_lifecycle_keeps_original_articles(self):
        created = self.http.post("/workbench/api/clients", headers=self.headers,
                                 json={"name": "新客户", "description": "测试"})
        self.assertEqual(created.status_code, 200)
        client_id = created.json()["id"]
        self.assertEqual(desk.articles(client_id, user=self.user)["total"], 0)
        bound = self.http.post("/workbench/api/clients/"+client_id+"/sources", headers=self.headers,
            json={"name": "来源甲", "identifier": "MP_WXS_123456", "category": "观察"})
        self.assertEqual(bound.status_code, 200)
        self.assertEqual(desk.articles(client_id, user=self.user)["total"], 1)
        self.http.delete("/workbench/api/clients/"+client_id+"/sources/MP_WXS_123456",
                         headers=self.headers)
        self.assertEqual(desk.articles(client_id, user=self.user)["total"], 0)
        self.assertEqual(desk.articles("a", user=self.user)["total"], 1)
        self.http.put("/workbench/api/clients/"+client_id, headers=self.headers,
                      json={"name": "新客户", "archived": True})
        with self.assertRaises(ValueError):
            desk.articles(client_id, user=self.user)

    def test_source_identifiers_never_fetch_arbitrary_urls(self):
        self.assertEqual(desk.parse_source_id("https://mp.weixin.qq.com/s?__biz=MTIzNDU2"), "MP_WXS_123456")
        self.assertEqual(desk.parse_source_id("https://weread.qq.com/x?bookId=MP_WXS_123456"), "MP_WXS_123456")
        for value in ("http://127.0.0.1", "https://evil.test/s?__biz=MTIzNDU2", "https://mp.weixin.qq.com/s/short"):
            with self.assertRaises(ValueError):
                desk.parse_source_id(value)

    def test_export_scoped_and_formula_safe(self):
        with self.factory.begin() as db:
            db.get(Article, "a1").title = "=HYPERLINK(\"malicious\")"
        rows = list(csv.reader(io.StringIO(desk.export_csv("a", user=self.user).lstrip("\ufeff"))))
        self.assertEqual(len(rows), 2)
        self.assertTrue(rows[1][3].startswith("'="))
        self.assertEqual(rows[1][6:8], ["", ""])
        self.assertNotIn("乙方专属", str(rows))

    def test_local_boundary_rejects_cross_origin_and_missing_header(self):
        self.assertEqual(self.http.get("/workbench/api/articles?client_id=a",
            headers={"Origin": "https://attacker.test"}).status_code, 403)
        self.assertEqual(self.http.post("/workbench/api/clients", json={"name": "不允许"}).status_code, 403)
        self.assertEqual(self.http.get("/workbench/api/articles?client_id=a",
            headers={"Host": "attacker.test"}).status_code, 403)

    def test_settings_do_not_return_key(self):
        with patch.object(desk, "schedule_daily"):
            result = self.http.put("/workbench/api/settings", headers=self.headers,
                json={"brand":"测试台", "model":"standard", "api_key":"sk-test-not-real",
                      "daily_time":"10:30", "daily_enabled":False})
            self.assertEqual(result.status_code, 200)
            self.assertTrue(result.json()["key_configured"])
            self.assertNotIn("sk-test-not-real", result.text)
            self.assertEqual(desk.settings()["api_key"], "sk-test-not-real")
            self.assertEqual(result.json()["model"], "standard")
            self.assertNotIn("deepseek", result.text.lower())
            changed = self.http.put("/workbench/api/settings", headers=self.headers,
                json={"brand":"测试台", "model":"advanced", "daily_time":"10:30", "daily_enabled":False})
            self.assertEqual(changed.status_code, 200)
            self.assertEqual(desk.settings()["model"], "deepseek-v4-pro")
            self.assertEqual(changed.json()["model"], "advanced")
            bad = self.http.put("/workbench/api/settings", headers=self.headers,
                json={"brand":"测试台", "model":"standard", "daily_time":"99:99"})
            self.assertEqual(bad.status_code, 422)

    def test_missing_model_key_is_an_explicit_error(self):
        with patch.object(desk, "settings", return_value={"api_key": "", "model":"deepseek-flash"}):
            with self.assertRaisesRegex(ValueError, "尚未配置"):
                asyncio.run(desk.deepseek([]))

    def test_official_search_key_stays_private_and_search_returns_only_accounts(self):
        with patch.object(desk, "schedule_daily"):
            response = self.http.put("/workbench/api/settings", headers=self.headers,
                json={"brand":"测试台", "model":"standard", "daily_time":"09:00",
                      "weread_api_key":"wrk-test-not-real"})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["weread_search_configured"])
        self.assertNotIn("wrk-test-not-real", response.text)
        with patch.object(desk.httpx, "AsyncClient") as client:
            post = client.return_value.__aenter__.return_value.post
            post.return_value = Mock(status_code=200)
            post.return_value.json.return_value = {"results":[{"books":[
                {"bookInfo":{"bookId":"MP_WXS_123456", "title":"测试来源"}},
                {"bookInfo":{"bookId":"123456", "title":"同名电子书"}}]}], "hasMore":0}
            found = asyncio.run(desk.search_sources("测试来源"))
            self.assertEqual(found["items"], [{"id":"MP_WXS_123456", "name":"测试来源"}])
            self.assertEqual(post.await_args.kwargs["json"]["scope"], 2)
            self.assertEqual(post.await_args.args[0], "https://i.weread.qq.com/api/agent/gateway")
            post.return_value.json.return_value = {"results":[{"books":[
                {"bookInfo":{"bookId":"123456", "title":"电子书"}}]}]}
            with self.assertRaisesRegex(ValueError, "不代表公众号不存在"):
                asyncio.run(desk.search_sources("测试来源"))
            post.return_value.json.return_value = {"errcode":-2041}
            with self.assertRaisesRegex(ValueError, "-2041"):
                asyncio.run(desk.search_sources("测试来源"))
        with patch.object(desk, "schedule_daily"):
            desk.save_settings({"weread_api_key":""})
        with self.assertRaisesRegex(ValueError, "官方 API Key"):
            asyncio.run(desk.search_sources("测试来源"))

    def test_wechat_backend_search_validates_ids_and_preserves_errors(self):
        with patch("core.wx.search_Biz") as search:
            search.return_value = {"list":[{"fakeid":"MTIzNDU2", "nickname":"项有所成"}], "total":1}
            result = self.http.get("/workbench/api/wechat/search?q=项有所成")
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()["items"], [{"id":"MP_WXS_123456", "name":"项有所成"}])
            search.assert_called_once_with("项有所成", limit=10)
            search.side_effect = RuntimeError("公众号后台搜索触发频率限制（200013），本次已停止")
            result = self.http.get("/workbench/api/wechat/search?q=项有所成")
            self.assertEqual(result.status_code, 400)
            self.assertIn("200013", result.text)
            search.side_effect = None
            search.return_value = {"list":[{"fakeid":"not-an-id", "nickname":"错误来源"}]}
            self.assertEqual(self.http.get("/workbench/api/wechat/search?q=项有所成").status_code, 400)

    def test_wechat_login_exposes_status_only_and_sends_no_notification_callback(self):
        with patch("driver.wx.WX_API") as wx, patch("driver.token.get", return_value="private-token"):
            wx.HasLogin.return_value = True
            wx.GetHasCode.return_value = False
            wx.check_lock.return_value = False
            result = self.http.post("/workbench/api/wechat/qr", headers=self.headers)
            self.assertEqual(result.status_code, 200)
            wx.GetCode.assert_called_once_with()
            result = self.http.get("/workbench/api/wechat/status")
            self.assertEqual(result.json(), {"logged_in":True, "qr_ready":False, "running":False})
            self.assertNotIn("private-token", result.text)
            for running, ready, logged, expected in (
                (True, False, False, {"logged_in":False, "qr_ready":False, "running":True}),
                (True, True, False, {"logged_in":False, "qr_ready":True, "running":True}),
                (True, True, True, {"logged_in":False, "qr_ready":True, "running":True}),
                (False, True, False, {"logged_in":False, "qr_ready":False, "running":False}),
            ):
                with self.subTest(running=running, ready=ready, logged=logged):
                    wx.check_lock.return_value = running
                    wx.GetHasCode.return_value = ready
                    wx.HasLogin.return_value = logged
                    self.assertEqual(self.http.get("/workbench/api/wechat/status").json(), expected)
            self.assertEqual(self.http.post("/workbench/api/wechat/qr").status_code, 403)

    def test_wechat_search_stops_on_limits_without_notification_or_retry(self):
        from core.wx.base import WxGather
        provider = WxGather.__new__(WxGather)
        provider.token = "test-token"
        provider.get_token = Mock()
        provider.fix_header = Mock(return_value={})
        provider._get_proxies = Mock(return_value=None)
        provider.Error = Mock()
        with patch("core.wx.base.requests.get") as request:
            request.return_value.text = json.dumps({"base_resp":{"ret":200013}})
            with self.assertRaisesRegex(RuntimeError, "200013"):
                provider.search_Biz("测试来源")
            request.assert_called_once()
            self.assertEqual(request.call_args.kwargs["timeout"], (10, 20))
            provider.Error.assert_not_called()
        provider.token = ""
        with self.assertRaisesRegex(RuntimeError, "扫码登录"):
            provider.search_Biz("测试来源")

    def test_reader_keeps_format_and_images_without_executable_content(self):
        raw = ('<section><h2 style="color:#087f8c">标题</h2><p>正文<strong>重点</strong>连续句子</p>'
               '<img data-src="https://mmbiz.qpic.cn/photo.png" onerror="alert(1)">'
               '<img src="http://localhost:1234/private"><img src="https://mmbiz.qpic.cn:bad/x">'
               '<script>alert(1)</script><iframe src="/private"></iframe><input autofocus>'
               '<p style="background:url(https://evil.test);color:red" onclick="alert(1)">文字</p></section>')
        document = desk.reader_document(raw)
        self.assertIn('color:#087f8c', document)
        self.assertIn('src="https://mmbiz.qpic.cn/photo.png"', document)
        self.assertNotIn('onerror', document)
        self.assertNotIn('onclick', document)
        self.assertNotIn('localhost', document)
        self.assertNotIn('evil.test', document)
        self.assertNotIn('<script', document)
        self.assertNotIn('<iframe', document)
        self.assertIn('正文重点连续句子', desk.plain_text(raw))
        response = self.http.get('/workbench/api/article/reader?client_id=a&article_id=a1')
        self.assertEqual(response.status_code, 200)
        self.assertIn("default-src 'none'", response.headers['content-security-policy'])
        self.assertIn('sandbox allow-same-origin', response.headers['content-security-policy'])
        self.assertEqual(self.http.get('/workbench/api/article/reader?client_id=a&article_id=b1').status_code, 400)
        footer_html = '<p>' + '这是真正的正文。' * 80 + '</p><section><span>近期热文：</span><a>PMP 推荐文章</a></section>'
        cleaned = desk.searchable_body(desk.plain_text(footer_html))
        self.assertIn('真正的正文', cleaned)
        self.assertNotIn('PMP', cleaned)

    def test_topics_cached_manual_terms_preserved_and_body_still_searchable(self):
        with self.factory.begin() as db:
            original = db.get(Article, 'b1')
            db.add(Article(id='b-copy', mp_id=original.mp_id, title=original.title,
                           content=original.content, status=1, publish_time=int(time.time())-20))
            db.add(desk.Selection(client_id='b', article_id='b1', keywords=json.dumps(['人工主题'])))
        model = AsyncMock(return_value={'primary':['项目风险','风险沟通','项目管理'],
                                       'search':['项目风险','风险沟通','项目管理','风险跟踪','别名测试']})
        with patch.object(desk, 'settings', return_value={'api_key':'test', 'model':'test-model'}), patch.object(desk,'deepseek',model):
            ids = desk.prepare_keywords('b', user=self.user)
            desk.execute_keywords(ids, 'b', user=self.user)
            self.assertEqual(model.await_count, 1)
            self.assertEqual(desk.prepare_keywords('b', user=self.user), [])
            desk.execute_keywords([], 'b', user=self.user)
        item = desk.article_detail('b', 'b1', user=self.user)
        self.assertEqual(item['keywords'], ['人工主题'])
        self.assertIn('别名测试', item['search_keywords'])
        self.assertEqual(desk.articles('b', q='别名测试', user=self.user)['total'], 2)
        self.assertEqual(desk.articles('a', q='别名测试', user=self.user)['total'], 0)
        self.assertEqual(desk.articles('b', q='乙方专属', user=self.user)['items'][0]['match_type'], '正文命中')
        with self.factory.begin() as db:
            db.get(Article, 'b1').content = '更新后的正文'
        self.assertEqual(desk.articles('b', q='别名测试', user=self.user)['total'], 1)
        self.assertFalse(desk._keyword_lock.locked())

    def test_topic_failure_preserves_prior_data_and_releases_worker(self):
        with patch.object(desk, 'settings', return_value={'api_key':'test','model':'test'}), patch.object(desk, 'deepseek', AsyncMock(return_value={'primary':'bad'})):
            desk.execute_keywords(desk.prepare_keywords('b', user=self.user), 'b', user=self.user)
        self.assertFalse(desk._keyword_lock.locked())
        self.assertEqual(desk._keyword_status[self.user.id]['failed'], 1)
        self.assertEqual(desk.article_detail('b','b1', user=self.user)['keyword_method'], 'title')

    def test_agent_uses_only_selected_clients_evidence(self):
        model = AsyncMock(side_effect=[
            {"client":"乙客户", "keywords":"PMP", "days":7},
            {"answer":"根据[1]可以参考这个主题。"},
        ])
        with patch.object(desk, "deepseek", model):
            answer = asyncio.run(desk.chat("a", "乙客户 PMP", [], user=self.user))
        self.assertEqual(answer["client_id"], "b")
        self.assertEqual([a["id"] for a in answer["items"]], ["b1"])
        evidence = json.loads(model.await_args_list[1].args[0][1]["content"])
        self.assertEqual(evidence["articles"][0]["excerpt"], "乙方专属")
        self.assertNotIn("项目风险实践", json.dumps(evidence, ensure_ascii=False))

    def test_agent_unknown_client_does_not_fall_back(self):
        with patch.object(desk, "deepseek", AsyncMock(return_value={"client":"不存在","keywords":"PMP","days":7})):
            with self.assertRaisesRegex(ValueError, "没有找到客户"):
                asyncio.run(desk.chat("a", "不存在 PMP", [], user=self.user))

    def test_eason_identity_is_product_name_without_model_request(self):
        with patch.object(desk, "deepseek", AsyncMock()) as model:
            answer = asyncio.run(desk.chat("a", "你是谁？", [], user=self.user))
        self.assertIn("Eason", answer["answer"])
        self.assertEqual(answer["mode"], "agent")
        model.assert_not_awaited()

    def test_rejected_collection_stops_and_explains_new_article_impact(self):
        from core.wx.model.weread_mp import WereadMPAPIError
        run_id, ids = desk.prepare_sync("a", user=self.user)
        with patch("core.wx.model.weread_mp.MpsWereadMP") as collector:
            error = WereadMPAPIError(-2041, "rejected", False)
            error.endpoint = "/web/mp/articles"
            collector.return_value.get_Articles.side_effect = error
            desk.execute_sync(run_id, ids, user=self.user)
            self.assertEqual(collector.return_value.get_Articles.call_count, 1)
        with self.factory() as db:
            result = json.loads(db.get(desk.SyncRun, run_id).results)[0]
            self.assertEqual(result["code"], "-2041")
            self.assertEqual(result["endpoint"], "/web/mp/articles")
            self.assertIn("安全验证", result["message"])
            self.assertIn("尚未完成全部更新", result["message"])
            self.assertNotIn("配额", result["message"])

    def test_sync_keeps_callback_and_records_failure(self):
        run_id, ids = desk.prepare_sync("a", user=self.user)
        with self.assertRaisesRegex(ValueError, "执行中"):
            desk.prepare_sync("a", user=self.user)
        with patch("core.wx.model.weread_mp.MpsWereadMP") as collector:
            collector.return_value.get_Articles.side_effect = RuntimeError("provider failed")
            desk.execute_sync(run_id, ids, user=self.user)
            self.assertTrue(callable(collector.return_value.get_Articles.call_args.kwargs["CallBack"]))
        with self.factory() as db:
            self.assertEqual(db.get(desk.SyncRun, run_id).status, "failed")
        self.assertFalse(desk._sync_lock.locked())


if __name__ == "__main__":
    unittest.main()
