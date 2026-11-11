"""Fictional clients/accounts in a temporary database; no jobs or real models are started."""
import asyncio
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, insert, select
from sqlalchemy.orm import sessionmaker

from apis.fusion import router, monitor
from core import fusion, workbench as desk, workbench_auth as auth
from core.models import Article, Feed


class FusionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.engine = create_engine("sqlite:///" + str(Path(self.temp.name) / "fusion.db"),
                                    connect_args={"check_same_thread": False, "timeout": 10})
        self.addCleanup(self.engine.dispose)
        for target, name, value in [(auth, "_engine", self.engine),
                                    (desk, "Session", sessionmaker(self.engine, expire_on_commit=False)),
                                    (desk, "SETTINGS", Path(self.temp.name) / "settings.json"),
                                    (fusion, "KEY_PATH", Path(self.temp.name) / "fusion.key")]:
            change = patch.object(target, name, value)
            change.start()
            self.addCleanup(change.stop)
        env = patch.dict(os.environ, {"FUSION_SERVICE_TOKEN": "test-only-service-token-" + "x" * 32,
                        "EASON_PUBLIC_ORIGIN": "", "FUSION_PUBLIC_ORIGIN": "", "EASON_USER_AI_MIN_INTERVAL": "0",
                        "DEEPSEEK_API_KEY": ""})
        env.start()
        self.addCleanup(env.stop)
        auth.init_auth_tables(self.engine)
        for table in (Article.__table__, Feed.__table__, desk.Client.__table__, desk.Source.__table__,
                      desk.Selection.__table__, desk.SyncRun.__table__, desk.ArticleTopics.__table__):
            table.create(self.engine)
        fusion.init_fusion()
        self.password = "fictional-test-password"
        self.admin = auth.upsert_user("admin", self.password, "admin")
        self.member = auth.upsert_user("member", self.password, "user")
        self.external = auth.upsert_user("external", self.password, "user")
        now = int(time.time())
        with desk.Session.begin() as db:
            db.add_all([
                desk.Client(id="a", owner_id=self.admin.id, name="虚构甲客户", description="甲"),
                desk.Client(id="b", owner_id=self.admin.id, name="虚构乙客户", description="乙保密"),
                Feed(id="MP_WXS_111111", mp_name="甲来源"), Feed(id="MP_WXS_222222", mp_name="乙来源"),
                desk.Source(client_id="a", feed_id="MP_WXS_111111", category="甲分类"),
                desk.Source(client_id="b", feed_id="MP_WXS_222222", category="乙分类"),
                Article(id="a1", mp_id="MP_WXS_111111", title="已授权 PMP", content="<p>甲公开样本</p>",
                        publish_time=now-10, status=1),
                Article(id="a2", mp_id="MP_WXS_111111", title="未授权 PMP", content="甲未共享正文",
                        publish_time=now-20, status=1),
                Article(id="b1", mp_id="MP_WXS_222222", title="乙秘密 PMP", content="乙保密正文",
                        publish_time=now-30, status=1),
            ])
            db.execute(insert(fusion.members), [
                {"client_id": "a", "user_id": self.member.id, "role": "member", "grants": json.dumps(fusion.empty_grants())},
                {"client_id": "a", "user_id": self.external.id, "role": "external", "grants": json.dumps(
                    {"documents": ["doc1"], "tasks": [], "articles": ["a1"]})},
            ])
        app = FastAPI()
        app.include_router(router)
        app.mount("/fusion/monitor", monitor)
        self.app = app
        self.http = TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 8000))
        self.addCleanup(self.http.close)
        self.headers = {"Authorization": "Bearer " + fusion.service_key(), "X-Fusion-Client": "a"}

    def login(self, name="member"):
        response = self.http.post("/fusion/auth/login", json={"username": name, "password": self.password},
                                  headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        return response

    def get(self, path, **kwargs):
        return self.http.get("/fusion/monitor/" + path, headers=self.headers, **kwargs)

    def test_service_gate_real_login_and_disabled_session(self):
        self.assertEqual(self.http.get("/fusion/auth/session").status_code, 403)
        self.assertEqual(self.http.get("/fusion/auth/session", headers=self.headers).status_code, 401)
        remote = TestClient(self.app, base_url="http://127.0.0.1", client=("192.0.2.5", 8000))
        with remote:
            self.assertEqual(remote.get("/fusion/auth/session", headers=self.headers).status_code, 403)
        response = self.login()
        self.assertIn("Path=/;", response.headers["set-cookie"])
        self.assertIn("HttpOnly", response.headers["set-cookie"])
        self.assertNotIn(self.password, response.text)
        self.assertNotIn(self.http.cookies.get(auth.COOKIE_NAME), response.text)
        result = self.http.get("/fusion/auth/session", headers=self.headers).json()
        self.assertEqual([c["id"] for c in result["clients"]], ["a"])
        self.assertEqual(result["client"]["role"], "member")
        member_cookie = self.http.cookies.get(auth.COOKIE_NAME)
        self.login("admin")
        self.assertEqual(self.http.put("/fusion/admin/users/" + self.member.id, json={"active": False},
                                      headers=self.headers).status_code, 200)
        self.http.cookies.clear()
        self.http.cookies.set(auth.COOKIE_NAME, member_cookie)
        self.assertEqual(self.http.get("/fusion/auth/session", headers=self.headers).status_code, 401)

    def test_cookie_security_uses_configured_origin_not_forwarded_headers(self):
        response = self.http.post("/fusion/auth/login", json={"username": "member", "password": self.password},
                                  headers={**self.headers, "X-Forwarded-Proto": "https"})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("Secure", response.headers["set-cookie"])
        with patch.dict(os.environ, {"FUSION_PUBLIC_ORIGIN": "https://workspace.example.test"}):
            response = self.login()
            self.assertIn("Secure", response.headers["set-cookie"])
            self.assertIn("HttpOnly", response.headers["set-cookie"])
            self.assertIn("SameSite=lax", response.headers["set-cookie"])
            response = self.http.post("/fusion/auth/logout", headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertIn("Secure", response.headers["set-cookie"])
        for origin in ("http://workspace.example.test", "https://workspace.example.test/path", "https://user@workspace.example.test"):
            with patch.dict(os.environ, {"FUSION_PUBLIC_ORIGIN": origin}):
                with self.assertRaises(ValueError):
                    auth._public_origin("FUSION_PUBLIC_ORIGIN")

    def test_scope_all_query_body_and_state_paths(self):
        self.login()
        state = self.get("state")
        self.assertEqual(state.status_code, 200, state.text)
        self.assertNotIn("乙", state.text)
        self.assertNotIn("api_key", state.text)
        self.assertEqual(self.get("articles?client_id=b").status_code, 404)
        self.assertEqual(self.get("articles?client_id=a&client_id=b").status_code, 404)
        self.assertEqual(self.get("article?client_id=a&article_id=b1").status_code, 404)
        self.assertEqual(self.get("clients/b/sources").status_code, 404)
        self.assertEqual(self.http.post("/fusion/monitor/chat", headers=self.headers,
                         json={"client_id": "b", "message": "PMP"}).status_code, 404)
        self.assertEqual(self.http.get("/fusion/auth/session", headers={**self.headers,
                         "X-Fusion-Client": "b"}).status_code, 404)
        for path in ("settings", "wechat/status", "weread/status", "wechat/search?q=PMP"):
            self.assertEqual(self.get(path).status_code, 403)

    def test_external_reads_exports_and_model_context_are_grant_scoped(self):
        self.login("external")
        response = self.get("articles?client_id=a&q=PMP&days=0")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([x["id"] for x in response.json()["items"]], ["a1"])
        self.assertEqual(self.get("state").json()["clients"][0]["counts"]["all"], 1)
        self.assertNotIn("未授权", self.get("export?client_id=a&days=0").text)
        for path in ("article", "article/reader"):
            self.assertEqual(self.get(path + "?client_id=a&article_id=a2").status_code, 404)
            self.assertEqual(self.get(path + "?client_id=a&article_id=a1").status_code, 200)
        self.assertEqual(self.http.put("/fusion/monitor/article?client_id=a&article_id=a1",
                                      json={"note": "change"}, headers=self.headers).status_code, 403)
        contexts = []
        async def model(messages, max_tokens=1800):
            contexts.append(json.dumps(messages, ensure_ascii=False))
            return {"client": "虚构甲客户", "keywords": "PMP", "days": 0} if max_tokens == 500 else {"answer": "样本"}
        with patch.object(desk, "deepseek", model):
            result = self.http.post("/fusion/monitor/chat", headers=self.headers,
                                    json={"client_id": "a", "message": "PMP"})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual([a["id"] for a in result.json()["items"]], ["a1"])
        self.assertNotIn("乙", "".join(contexts))
        self.assertNotIn("甲未共享正文", "".join(contexts))
        with self.engine.connect() as conn:
            self.assertEqual(conn.execute(select(auth.usage.c.user_id)).scalar_one(), self.external.id)

    def test_chat_cannot_switch_to_owner_other_client(self):
        self.login()
        async def model(*args, **kwargs):
            return {"client": "虚构乙客户", "keywords": "PMP", "days": 0}
        with patch.object(desk, "deepseek", model):
            response = self.http.post("/fusion/monitor/chat", headers=self.headers,
                                     json={"client_id": "a", "message": "搜乙客户"})
        self.assertEqual(response.status_code, 400, response.text)
        self.assertNotIn("乙保密正文", response.text)

    def test_admin_accounts_members_and_two_client_limit(self):
        self.login()
        self.assertEqual(self.http.get("/fusion/admin/users", headers=self.headers).status_code, 403)
        self.assertEqual(self.http.put("/fusion/clients/a/members", headers=self.headers,
            json={"user_id": self.member.id, "role": "manager"}).status_code, 403)
        self.login("admin")
        response = self.http.get("/fusion/admin/users", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("password", response.text)
        created = self.http.post("/fusion/admin/users", headers=self.headers,
                                json={"username": "newperson", "password": self.password, "role": "user"})
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["user"]["username"], "newperson")
        self.assertNotIn("password", created.text)
        self.assertEqual(self.http.post("/fusion/clients", headers=self.headers,
                                      json={"name": "第三客户"}).status_code, 409)
        for _ in range(2):
            response = self.http.put("/fusion/clients/a/members", headers=self.headers,
                json={"user_id": self.external.id, "role": "external", "grants": {"articles": ["a2"]}})
            self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.http.put("/fusion/clients/a/members", headers=self.headers,
            json={"user_id": self.external.id, "role": "external", "grants": {"articles": ["b1"]}}).status_code, 400)
        self.assertEqual(self.http.put("/fusion/clients/a/members", headers=self.headers,
            json={"user_id": self.admin.id, "role": "member"}).status_code, 400)
        fusion.init_fusion()
        self.login("external")
        self.assertEqual([x["id"] for x in self.get("articles?client_id=a&days=0").json()["items"]], ["a2"])
        self.login("admin")
        self.assertEqual(self.http.delete("/fusion/clients/a/members/" + self.external.id,
                                        headers=self.headers).status_code, 200)
        self.login("external")
        self.assertEqual(self.get("articles?client_id=a").status_code, 404)
        response = self.http.post("/fusion/auth/logout", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.http.get("/fusion/auth/session", headers=self.headers).status_code, 401)

    def test_file_service_key_persists_without_rotating(self):
        with patch.dict(os.environ, {"FUSION_SERVICE_TOKEN": ""}):
            first = fusion.service_key()
            fusion.init_fusion()
            self.assertEqual(first, fusion.service_key())
            self.assertGreaterEqual(len(first), 32)
        with patch.dict(os.environ, {"FUSION_SERVICE_TOKEN": "short"}):
            with self.assertRaises(RuntimeError):
                fusion.service_key()

    def test_client_edit_requires_own_manager_or_owner(self):
        payload = {"name": "甲新定位", "description": "新的客户定位", "archived": False}
        self.login()
        self.assertEqual(self.http.put("/fusion/clients/a", headers=self.headers, json=payload).status_code, 403)
        self.assertEqual(self.http.put("/fusion/clients/b", headers=self.headers, json=payload).status_code, 404)
        visible = self.http.get("/fusion/clients?include_archived=true", headers=self.headers)
        self.assertEqual(visible.status_code, 200)
        self.assertEqual([c["id"] for c in visible.json()["items"]], ["a"])
        self.assertFalse(visible.json()["items"][0]["owned"])
        self.login("admin")
        self.assertEqual(self.http.put("/fusion/clients/a/members", headers=self.headers,
            json={"user_id": self.member.id, "role": "manager"}).status_code, 200)
        self.login()
        result = self.http.put("/fusion/clients/a", headers=self.headers, json=payload)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["description"], "新的客户定位")
        self.assertEqual(self.http.put("/fusion/clients/b", headers=self.headers, json=payload).status_code, 404)
        self.assertEqual(self.http.put("/fusion/clients/a", headers=self.headers,
            json={**payload, "archived": True}).status_code, 403)
        self.assertEqual(self.http.put("/fusion/clients/a", headers=self.headers,
            json={**payload, "owner_id": self.member.id}).status_code, 422)
        self.login("external")
        self.assertEqual(self.http.put("/fusion/clients/a", headers=self.headers, json=payload).status_code, 403)
        with desk.Session.begin() as db:
            db.get(desk.Client, "b").owner_id = self.external.id
        self.assertEqual(self.http.put("/fusion/clients/b", headers=self.headers, json=payload).status_code, 200)
        self.assertEqual(self.http.put("/fusion/clients/b", headers=self.headers,
            json={**payload, "archived": True}).status_code, 200)
        with desk.Session() as db:
            self.assertEqual(db.get(desk.Client, "a").owner_id, self.admin.id)

    def test_archive_revokes_access_but_preserves_client_data_and_members(self):
        with desk.Session.begin() as db:
            db.add(desk.Selection(client_id="a", article_id="a1", note="保留人工笔记"))
            db.add(desk.SyncRun(id="historic", client_id="a", owner_id=self.admin.id,
                               status="succeeded", started=1, results="[]"))
        self.login("admin")
        response = self.http.put("/fusion/clients/a", headers=self.headers,
            json={"name": "虚构甲客户", "description": "甲", "archived": True})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["archived"])
        for username in ("member", "external", "admin"):
            self.login(username)
            self.assertEqual(self.http.get("/fusion/auth/session", headers=self.headers).status_code, 404)
            self.assertEqual(self.get("state").status_code, 404)
            self.assertEqual(self.get("article?client_id=a&article_id=a1").status_code, 404)
            self.assertEqual(self.http.get("/fusion/clients/a/members", headers=self.headers).status_code, 404)
            self.assertNotIn("a", [x["id"] for x in self.http.get("/fusion/clients", headers=self.headers).json()["items"]])
            if username != "admin":
                response = self.http.get("/fusion/clients?include_archived=true", headers=self.headers)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["items"], [])
                self.assertEqual(self.http.put("/fusion/clients/a", headers=self.headers,
                    json={"name": "企图恢复", "archived": False}).status_code, 404)
        items = self.http.get("/fusion/clients?include_archived=true", headers=self.headers).json()["items"]
        archived = next(x for x in items if x["id"] == "a")
        self.assertEqual((archived["archived"], archived["role"], archived["grants"]),
                         (True, "manager", fusion.empty_grants()))
        with desk.Session() as db:
            self.assertEqual(db.get(desk.Client, "a").owner_id, self.admin.id)
            self.assertIsNotNone(db.get(desk.Source, ("a", "MP_WXS_111111")))
            self.assertIn("甲公开样本", db.get(Article, "a1").content)
            self.assertEqual(db.get(desk.Selection, ("a", "a1")).note, "保留人工笔记")
            self.assertIsNotNone(db.get(desk.SyncRun, "historic"))
            self.assertEqual(len(db.execute(select(fusion.members).where(fusion.members.c.client_id == "a")).all()), 2)

    def test_ordinary_account_creates_owns_and_restores_isolated_spaces(self):
        owner = auth.upsert_user("selfservice", self.password, "user")
        self.assertEqual(self.http.post("/fusion/clients", headers=self.headers,
                                       json={"name": "未登录"}).status_code, 401)
        self.assertEqual(self.login("selfservice").json()["clients"], [])
        self.assertEqual(self.http.post("/fusion/clients", headers=self.headers,
            json={"name": "伪造所有者", "owner_id": self.admin.id}).status_code, 422)
        created = self.http.post("/fusion/clients", headers=self.headers, json={"name": "虚构甲客户"})
        self.assertEqual(created.status_code, 200, created.text)
        first = created.json()["id"]
        self.assertTrue(created.json()["owned"])
        self.assertEqual(created.json()["role"], "manager")
        self.assertEqual(self.http.post("/fusion/clients", headers=self.headers,
            json={"name": "虚构甲客户"}).status_code, 409)
        second = self.http.post("/fusion/clients", headers=self.headers, json={"name": "第二自建空间"})
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(self.http.post("/fusion/clients", headers=self.headers,
            json={"name": "超出本人额度"}).status_code, 409)
        own_headers = {**self.headers, "X-Fusion-Client": first}
        state = self.http.get("/fusion/monitor/state", headers=own_headers)
        self.assertEqual(state.status_code, 200, state.text)
        self.assertEqual(state.json()["clients"][0]["counts"]["all"], 0)
        self.assertEqual(self.http.get("/fusion/auth/session", headers=self.headers).status_code, 404)
        self.assertEqual(self.http.get("/fusion/admin/users", headers=own_headers).status_code, 403)
        self.assertEqual(self.http.put("/fusion/clients/a", headers=self.headers,
            json={"name": "不能修改别人"}).status_code, 404)
        archive = {"name": "我的知识库", "description": "自己的资料", "archived": True}
        self.assertEqual(self.http.put("/fusion/clients/" + first, headers=self.headers,
            json=archive).status_code, 200)
        visible = self.http.get("/fusion/clients?include_archived=true", headers=self.headers).json()["items"]
        self.assertEqual({c["id"] for c in visible}, {first, second.json()["id"]})
        self.assertTrue(all(c["owned"] for c in visible))
        self.assertEqual(self.http.get("/fusion/auth/session", headers=own_headers).status_code, 404)
        self.login("external")
        visible = self.http.get("/fusion/clients?include_archived=true", headers=self.headers).json()["items"]
        self.assertEqual([c["id"] for c in visible], ["a"])
        self.assertEqual(self.http.put("/fusion/clients/" + first, headers=self.headers,
            json={**archive, "archived": False}).status_code, 404)
        # Admin's two spaces do not consume another account's restore allowance.
        self.login("admin")
        restored = self.http.put("/fusion/clients/" + first, headers=self.headers,
            json={**archive, "archived": False})
        self.assertEqual(restored.status_code, 200, restored.text)
        self.login("selfservice")
        self.assertEqual(self.http.get("/fusion/auth/session", headers=own_headers).status_code, 200)
        self.assertEqual(self.http.put("/fusion/clients/" + first, headers=self.headers,
            json=archive).status_code, 200)
        third = self.http.post("/fusion/clients", headers=self.headers, json={"name": "腾出额度后新建"})
        self.assertEqual(third.status_code, 200, third.text)
        self.assertEqual(self.http.put("/fusion/clients/" + first, headers=self.headers,
            json={**archive, "archived": False}).status_code, 409)
        with desk.Session() as db:
            self.assertEqual(db.get(desk.Client, first).owner_id, owner.id)
            self.assertTrue(db.get(desk.Client, first).archived)
            self.assertEqual(db.get(desk.Client, "a").owner_id, self.admin.id)
            self.assertEqual(db.query(Article).count(), 3)

    def test_restore_capacity_and_name_conflicts_roll_back_then_admin_restores(self):
        self.login("admin")
        original = {"name": "虚构甲客户", "description": "甲", "archived": True}
        self.assertEqual(self.http.put("/fusion/clients/a", headers=self.headers, json=original).status_code, 200)
        created = self.http.post("/fusion/clients", headers=self.headers, json={"name": "虚构丙客户"})
        self.assertEqual(created.status_code, 200, created.text)
        third_id = created.json()["id"]
        response = self.http.put("/fusion/clients/a", headers=self.headers,
            json={"name": "不应写入", "description": "不应覆盖", "archived": False})
        self.assertEqual(response.status_code, 409)
        with desk.Session() as db:
            row = db.get(desk.Client, "a")
            self.assertEqual((row.name, row.description, row.archived), (original["name"], "甲", True))
        self.assertEqual(self.http.put("/fusion/clients/" + third_id, headers=self.headers,
            json={"name": "虚构丙客户", "archived": True}).status_code, 200)
        self.assertEqual(self.http.put("/fusion/clients/a", headers=self.headers,
            json={"name": "虚构乙客户", "archived": False}).status_code, 409)
        result = self.http.put("/fusion/clients/a", headers=self.headers,
            json={**original, "archived": False})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertFalse(result.json()["archived"])
        self.login("external")
        self.assertEqual(self.get("article?client_id=a&article_id=a1").status_code, 200)
        self.assertEqual(self.get("article?client_id=a&article_id=a2").status_code, 404)

    def test_internal_active_ids_require_service_gate_without_user_session(self):
        path = "/fusion/internal/clients"
        self.assertEqual(self.http.get(path).status_code, 403)
        self.assertEqual(self.http.get(path, headers={"Authorization": "Bearer wrong"}).status_code, 403)
        with TestClient(self.app, client=("192.0.2.8", 8000)) as remote:
            self.assertEqual(remote.get(path, headers=self.headers).status_code, 403)
        self.assertEqual(set(self.http.get(path, headers=self.headers).json()["active_ids"]), {"a", "b"})
        with desk.Session.begin() as db:
            db.get(desk.Client, "a").archived = True
            db.add(desk.Client(id="unowned", owner_id="", name="未认领测试"))
        result = self.http.get(path, headers=self.headers)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json(), {"active_ids": ["b"]})
        self.assertNotIn("乙", result.text)

    def test_monitor_source_crud_and_admin_qr_link_use_bridge(self):
        self.login()
        path = "/fusion/monitor/clients/a/sources"
        response = self.http.post(path, headers=self.headers, json={"name": "虚构新来源",
            "identifier": "MP_WXS_333333", "category": "测试"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.http.put(path + "/MP_WXS_333333", headers=self.headers,
            json={"category": "新分类", "enabled": False}).status_code, 200)
        source = next(s for s in self.get("state").json()["clients"][0]["sources"] if s["id"] == "MP_WXS_333333")
        self.assertEqual((source["category"], source["enabled"]), ("新分类", False))
        self.assertEqual(self.http.delete(path + "/MP_WXS_333333", headers=self.headers).status_code, 200)
        self.login("admin")
        with patch("driver.wx.WX_API.GetCode") as qr:
            response = self.http.post("/fusion/monitor/wechat/qr", headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        qr.assert_called_once()
        self.assertEqual(response.json()["url"], "/api/fusion/monitor/wechat/qr-image")
        desk.SETTINGS.write_text(json.dumps({"api_key": "fake-private-key", "weread_api_key": "fake-weread-key"}), encoding="utf-8")
        response = self.get("settings")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("fake-private-key", response.text)
        self.assertNotIn("fake-weread-key", response.text)

    def test_promotions_are_client_hidden_recoverable_and_human_choices_survive(self):
        with desk.Session.begin() as db:
            db.add_all([
                Article(id="promo", mp_id="MP_WXS_111111", title="限时优惠：课程早鸟价",
                        content="<p>立即报名，扫码报名，优惠价 99 元。</p>", publish_time=int(time.time())-5, status=1),
                Article(id="teaching", mp_id="MP_WXS_111111", title="如何编写招生简章",
                        content="<p>需求分析是第一步。" + "本文解释用户调研与项目计划。" * 60 + "</p><p>扫码报名</p>",
                        publish_time=int(time.time())-5, status=1),
                Article(id="restored", mp_id="MP_WXS_111111", title="限时优惠",
                        content="立即购买，优惠价 99 元", publish_time=int(time.time())-5, status=1),
                desk.Selection(client_id="a", article_id="restored", hidden=False, note="人工保留"),
            ])
        scoped = fusion.ScopedPrincipal(self.admin.id, "member", "user", self.member.id, "a")
        desk.apply_promotion_exclusions("a", "MP_WXS_111111", user=scoped)
        visible = {item["id"] for item in desk.articles("a", days=0, user=scoped)["items"]}
        self.assertNotIn("promo", visible)
        self.assertTrue({"teaching", "restored"}.issubset(visible))
        self.assertEqual([item["id"] for item in desk.articles("a", days=0, view="excluded", user=scoped)["items"]], ["promo"])
        self.login()
        self.assertEqual(self.http.put("/fusion/monitor/article?client_id=a&article_id=promo", headers=self.headers,
                                      json={"hidden": False}).status_code, 200)
        desk.apply_promotion_exclusions("a", "MP_WXS_111111", user=scoped)
        self.assertIn("promo", {item["id"] for item in desk.articles("a", days=0, user=scoped)["items"]})
        self.assertIn("立即报名", desk.article_detail("a", "promo", user=scoped)["content"])

    def test_seven_users_queue_two_model_jobs_and_keep_individual_usage(self):
        actors = [self.admin, self.member, self.external] + [auth.upsert_user("person" + str(i), self.password, "user") for i in range(4)]
        people = [fusion.ScopedPrincipal(self.admin.id, a.username, "user", a.id, "a") for a in actors]
        running = peak = 0
        async def model(messages, max_tokens=1800):
            nonlocal running, peak
            running += 1
            peak = max(peak, running)
            await asyncio.sleep(0.03)
            running -= 1
            return {"client": "虚构甲客户", "keywords": "PMP", "days": 0} if max_tokens == 500 else {"answer": "测试"}
        async def run():
            return await asyncio.gather(*(desk.chat("a", "PMP", [], user=u) for u in people))
        with patch.object(desk, "deepseek", model):
            result = asyncio.run(run())
        self.assertEqual(len(result), 7)
        self.assertEqual(peak, 2)
        with self.engine.connect() as conn:
            rows = conn.execute(select(auth.usage.c.user_id, auth.usage.c.status)).all()
        self.assertEqual({row[0] for row in rows}, {a.id for a in actors})
        self.assertTrue(all(row[1] == "succeeded" for row in rows))


if __name__ == "__main__":
    unittest.main()
