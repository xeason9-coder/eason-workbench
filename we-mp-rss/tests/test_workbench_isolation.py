import ast
import asyncio
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, inspect
from sqlalchemy.orm import sessionmaker

from core import workbench as desk
from core import workbench_auth as auth
from core.models import Article
import test_workbench as workbench_tests


class IsolationTests(unittest.TestCase):
    def setUp(self):
        workbench_tests.WorkbenchTests.setUp(self)
        self.manager = auth.upsert_user("manager", "test-manager-password", "user")
        self.other = auth.upsert_user("otheruser", "test-other-password", "user")
        response = self.http.post("/workbench/api/auth/login", headers=self.headers,
                                  json={"username": "manager", "password": "test-manager-password"})
        self.assertEqual(response.status_code, 200)
        no_network = patch("requests.sessions.Session.request", side_effect=AssertionError("network forbidden in isolation test"))
        no_network.start()
        self.addCleanup(no_network.stop)

    def test_fresh_space_and_cross_owner_attack_matrix(self):
        response = self.http.get("/workbench/api/state")
        self.assertEqual(response.status_code, 200)
        state = response.json()
        self.assertEqual(state["user"]["id"], self.manager.id)
        for field in ("clients", "runs", "available_sources"):
            self.assertEqual(state[field], [])
        self.assertEqual(set(state["settings"]), {"brand", "key_configured", "daily_time", "daily_enabled"})
        self.assertNotIn("wechat_configured", state)
        attempts = [
            ("get", "/workbench/api/articles?client_id=a", None),
            ("get", "/workbench/api/article?client_id=a&article_id=a1", None),
            ("get", "/workbench/api/article/reader?client_id=a&article_id=a1", None),
            ("get", "/workbench/api/export?client_id=a", None),
            ("put", "/workbench/api/article?client_id=a&article_id=a1", {"note": "attack", "hidden": True}),
            ("put", "/workbench/api/clients/a", {"name": "attack"}),
            ("post", "/workbench/api/clients/a/sources", {"name": "attack", "identifier": "MP_WXS_999999"}),
            ("put", "/workbench/api/clients/a/sources/MP_WXS_123456", {"category": "attack", "enabled": False}),
            ("delete", "/workbench/api/clients/a/sources/MP_WXS_123456", None),
            ("post", "/workbench/api/sync", {"client_id": "a"}),
            ("post", "/workbench/api/keywords", {"client_id": "a"}),
            ("post", "/workbench/api/chat", {"client_id": "a", "message": "show all"}),
        ]
        for method, path, data in attempts:
            response = self.http.request(method, path, headers=self.headers, json=data)
            self.assertIn(response.status_code, (400, 403, 404), (method, path, response.text))
            self.assertNotIn("项目风险实践", response.text)
        self.assertFalse(desk.article_detail("a", "a1", user=self.user)["hidden"])
        self.assertEqual(desk.article_detail("a", "a1", user=self.user)["note"], "")
        with self.factory() as db:
            self.assertEqual(db.query(desk.SyncRun).count(), 0)
            self.assertEqual(db.query(auth.usage).count(), 0)

    def test_admin_only_platform_controls_and_anonymous_api(self):
        for method, path, payload in [
            ("put", "settings", {"brand": "bad", "model": "standard", "daily_time": "09:00"}),
            ("post", "model-test", None), ("post", "wechat/qr", None),
            ("get", "wechat/status", None), ("get", "wechat/qr-image", None),
            ("post", "weread/qr", None), ("get", "weread/status", None),
            ("get", "weread/shelf", None), ("get", "weread/qr-image", None),
        ]:
            response = self.http.request(method, "/workbench/api/" + path, headers=self.headers, json=payload)
            self.assertEqual(response.status_code, 403, path)
        self.http.cookies.clear()
        self.assertEqual(self.http.get("/workbench/api/state").status_code, 401)
        self.assertEqual(self.http.get("/workbench/", follow_redirects=False).status_code, 303)
        self.assertEqual(self.http.get("/workbench/healthz").json(), {"status": "ok", "version": desk.DESK_VERSION})

    def test_shared_public_feed_private_notes_and_duplicate_names(self):
        response = self.http.post("/workbench/api/clients", headers=self.headers, json={"name": "甲客户"})
        self.assertEqual(response.status_code, 200)
        client_id = response.json()["id"]
        self.assertEqual(self.http.post("/workbench/api/clients", headers=self.headers,
                                       json={"name": "甲客户"}).status_code, 409)
        self.assertEqual(self.http.post(f"/workbench/api/clients/{client_id}/sources", headers=self.headers,
            json={"name": "来源甲", "identifier": "MP_WXS_123456"}).status_code, 200)
        self.assertEqual(self.http.put(f"/workbench/api/article?client_id={client_id}&article_id=a1",
            headers=self.headers, json={"note": "经理私有笔记", "favorite": True, "hidden": True}).status_code, 200)
        self.assertEqual(desk.article_detail(client_id, "a1", user=self.manager)["note"], "经理私有笔记")
        self.assertEqual(desk.article_detail("a", "a1", user=self.user)["note"], "")
        with self.assertRaises(ValueError):
            desk.article_detail(client_id, "a1", user=self.user)
        with self.assertRaises(ValueError):
            desk.article_detail(client_id, "a1", user=self.other)
        state = self.http.get("/workbench/api/state").json()
        self.assertEqual([c["id"] for c in state["clients"]], [client_id])
        self.assertEqual([s["id"] for s in state["available_sources"]], ["MP_WXS_123456"])

    def test_ai_plan_never_exposes_other_clients_and_is_charged_once(self):
        with self.factory.begin() as db:
            db.add(desk.Client(id="manager-client", owner_id=self.manager.id, name="经理客户"))
            db.add(desk.Source(client_id="manager-client", feed_id="MP_WXS_123456"))
        model = AsyncMock(return_value={"client": "甲客户", "keywords": "PMP", "days": 7})
        with patch.object(desk, "deepseek", model):
            with self.assertRaises(ValueError):
                asyncio.run(desk.chat("manager-client", "查甲客户", [], user=self.manager))
        self.assertNotIn("甲客户", model.await_args.args[0][0]["content"])
        with self.factory() as db:
            records = db.query(auth.usage).filter(auth.usage.c.user_id == self.manager.id).all()
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0].status, "failed")
        model = AsyncMock(side_effect=[{"client": "经理客户", "keywords": "PMP", "days": 7}, {"answer": "依据[1]"}])
        with patch.object(desk, "deepseek", model):
            result = asyncio.run(desk.chat("manager-client", "PMP", [], user=self.manager))
        self.assertEqual(result["items"][0]["id"], "a1")
        self.assertEqual(model.await_count, 2)
        with self.factory() as db:
            self.assertEqual(db.query(auth.usage).filter(auth.usage.c.user_id == self.manager.id).count(), 2)

    def test_partial_sync_records_real_new_ids_and_owner(self):
        from core.wx.model.weread_mp import WereadMPAPIError
        run_id, ids = desk.prepare_sync("a", user=self.user)

        def collect(**kwargs):
            with self.factory.begin() as db:
                db.add(Article(id="new-before-error", mp_id="MP_WXS_123456", title="已入库正文",
                               content="真实新增", status=1, publish_time=int(time.time())))
            raise WereadMPAPIError(-2041, "blocked", False)

        with patch("core.wx.model.weread_mp.MpsWereadMP") as provider:
            provider.return_value.get_Articles.side_effect = collect
            desk.execute_sync(run_id, ids, user=self.user)
        with self.factory() as db:
            run = db.get(desk.SyncRun, run_id)
            self.assertEqual(run.owner_id, self.user.id)
            self.assertEqual(run.status, "partial")
            result = json.loads(run.results)[0]
            self.assertEqual(result["added"], 1)
            self.assertEqual(result["articles"], [{"id": "new-before-error", "title": "已入库正文"}])
        self.assertEqual(self.http.get("/workbench/api/state").json()["runs"], [])

    def test_scheduled_shared_feed_checked_once_without_duplicating_added_counts(self):
        from core.wx.model.weread_mp import WereadMPAPIError
        with self.factory.begin() as db:
            db.get(desk.Client, "b").archived = True
            db.add(desk.Client(id="manager-shared", owner_id=self.manager.id, name="经理客户"))
            db.add(desk.Source(client_id="manager-shared", feed_id="MP_WXS_123456"))
        for outcome in ("success", "partial", "failed"):
            with self.subTest(outcome=outcome):
                with self.factory() as db:
                    previous_runs = {r.id for r in db.query(desk.SyncRun)}

                def collect(**kwargs):
                    if outcome != "failed":
                        with self.factory.begin() as db:
                            db.add(Article(id="scheduled-" + outcome, mp_id="MP_WXS_123456", title="本轮新增",
                                           content="公开正文", status=1, publish_time=int(time.time())))
                    if outcome != "success":
                        raise WereadMPAPIError(-2041, "blocked", False)

                with patch("core.wx.model.weread_mp.MpsWereadMP") as provider:
                    provider.return_value.get_Articles.side_effect = collect
                    desk.scheduled_sync()
                    provider.return_value.get_Articles.assert_called_once()
                with self.factory() as db:
                    runs = [r for r in db.query(desk.SyncRun) if r.id not in previous_runs]
                    self.assertEqual(len(runs), 2)
                    self.assertEqual({r.owner_id for r in runs}, {self.user.id, self.manager.id})
                    self.assertEqual({r.status for r in runs}, {outcome})
                    results = [json.loads(r.results)[0] for r in runs]
                self.assertEqual(sum(r["added"] for r in results), 0 if outcome == "failed" else 1)
                reused = next(r for r in results if r.get("reused"))
                self.assertEqual((reused["added"], reused["articles"]), (0, []))
                self.assertIn("复用本轮", reused["message"])
        with patch("core.wx.model.weread_mp.MpsWereadMP") as provider:
            desk.execute_sync(*desk.prepare_sync("a", user=self.user), user=self.user)
            provider.return_value.get_Articles.assert_called_once()

    def test_keywords_batch_counts_each_model_call_without_interactive_delay(self):
        with self.factory.begin() as db:
            db.add(Article(id="a-second", mp_id="MP_WXS_123456", title="第二个主题",
                           content="另一篇正文", publish_time=int(time.time()), status=1))
        value = {"primary": ["项目管理"], "search": ["项目管理", "风险"]}
        with patch.dict(os.environ, {"EASON_USER_AI_MIN_INTERVAL": "10"}), patch.object(desk, "settings", return_value={"api_key": "fake", "model": "fake"}), patch.object(desk, "deepseek", AsyncMock(return_value=value)):
            desk.execute_keywords(desk.prepare_keywords("a", user=self.user), "a", user=self.user)
        self.assertGreaterEqual(desk._keyword_status[self.user.id]["completed"], 2)
        self.assertEqual(desk._keyword_status[self.user.id]["failed"], 0)

    def test_workbench_boundary_blocks_all_legacy_routes(self):
        # Execute the actual middleware definition in an isolated app; do not start the real server.
        source = Path("web.py").read_text(encoding="utf-8")
        definition = next(n for n in ast.parse(source).body if isinstance(n, ast.AsyncFunctionDef) and n.name == "workbench_boundary")
        app = FastAPI()

        @app.get("/{path:path}")
        def any_route(path):
            return {"route": path}

        namespace = dict(app=app, os=os, Request=Request, JSONResponse=JSONResponse, RedirectResponse=RedirectResponse)
        exec(compile(ast.Module(body=[definition], type_ignores=[]), "web.py", "exec"), namespace)
        with patch.dict(os.environ, {"EASON_WORKBENCH_ONLY": "1"}), TestClient(app) as client:
            for path in ("/api/v1/wx/articles", "/views", "/feed/1", "/rss/1", "/static/weread_qrcode.png", "/files/x", "/api/docs", "/api/openapi.json"):
                self.assertEqual(client.get(path).status_code, 404, path)
            self.assertEqual(client.get("/", follow_redirects=False).status_code, 303)
            self.assertEqual(client.get("/workbench/healthz").status_code, 200)


class MigrationTests(unittest.TestCase):
    def test_failed_table_rebuild_rolls_back_to_original_schema_and_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rollback.db"
            with closing(sqlite3.connect(path)) as conn:
                conn.executescript("CREATE TABLE desk_clients(id TEXT PRIMARY KEY, name TEXT UNIQUE, description TEXT, archived BOOLEAN); INSERT INTO desk_clients VALUES('old','旧客户','保留',0);")
            engine = create_engine("sqlite:///" + str(path), isolation_level="AUTOCOMMIT")

            def interrupt(conn, cursor, statement, parameters, context, many):
                if statement.startswith("ALTER TABLE desk_clients_owner_upgrade"):
                    raise RuntimeError("simulated migration interruption")

            try:
                event.listen(engine, "before_cursor_execute", interrupt)
                with self.assertRaisesRegex(RuntimeError, "simulated"):
                    desk.ensure_workbench_schema(engine)
                event.remove(engine, "before_cursor_execute", interrupt)
                self.assertNotIn("owner_id", [c["name"] for c in inspect(engine).get_columns("desk_clients")])
                with engine.connect() as conn:
                    self.assertEqual(conn.exec_driver_sql("SELECT description FROM desk_clients").scalar_one(), "保留")
                self.assertEqual(len(list(Path(tmp).glob("*.workbench-backup-*"))), 1)
            finally:
                engine.dispose()

    def test_legacy_upgrade_preserves_all_rows_and_requires_admin_claim(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"EASON_PUBLIC_ORIGIN": ""}):
            path = Path(tmp) / "legacy.db"
            with closing(sqlite3.connect(path)) as conn:
                conn.executescript("""
                    CREATE TABLE desk_clients(id VARCHAR(40) PRIMARY KEY, name VARCHAR(80) NOT NULL UNIQUE, description VARCHAR(300), archived BOOLEAN);
                    INSERT INTO desk_clients VALUES ('old','旧客户','原说明',0);
                    CREATE TABLE desk_sync_runs(id VARCHAR(40) PRIMARY KEY, client_id VARCHAR(40), started INTEGER, finished INTEGER, status VARCHAR(20), results TEXT);
                    INSERT INTO desk_sync_runs VALUES ('run','old',100,200,'success','[]');
                    INSERT INTO desk_sync_runs VALUES ('orphan','removed-client',90,95,'failed','[]');
                """)
            engine = create_engine("sqlite:///" + str(path), isolation_level="AUTOCOMMIT")
            old_auth = auth._engine
            try:
                auth.init_auth_tables(engine)
                admin = auth.upsert_user("eason", "test-only-password", "admin")
                manager = auth.upsert_user("manager", "test-only-password", "user")
                for table in (desk.Source.__table__, desk.Selection.__table__, desk.ArticleTopics.__table__):
                    table.create(engine)
                factory = sessionmaker(engine.execution_options(isolation_level="SERIALIZABLE"), expire_on_commit=False)
                with factory.begin() as db:
                    db.add(desk.Source(client_id="old", feed_id="MP_WXS_123456", category="原分类"))
                    db.add(desk.Selection(client_id="old", article_id="article", note="原笔记", keywords='["手工词"]', favorite=True, hidden=True))
                    db.add(desk.ArticleTopics(article_id="article", content_hash="hash", primary_terms='["主题"]', search_terms='["检索"]', updated=321))
                with patch.object(desk, "Session", factory):
                    with self.assertRaises(ValueError):
                        desk.migrate_workbench_owners(manager.id)
                    result = desk.migrate_workbench_owners(admin.id)
                    self.assertTrue(Path(result["schema_backup"]).is_file())
                    self.assertEqual(result["clients_claimed"], 1)
                    self.assertEqual(result["runs_claimed"], 2)
                    self.assertEqual(desk.migrate_workbench_owners(admin.id)["clients_claimed"], 0)
                    with factory.begin() as db:
                        db.add(desk.Client(id="manager", owner_id=manager.id, name="旧客户"))
                    with factory() as db:
                        self.assertEqual(db.get(desk.Client, "old").owner_id, admin.id)
                        self.assertEqual(db.get(desk.Client, "old").description, "原说明")
                        self.assertEqual(db.get(desk.Source, ("old", "MP_WXS_123456")).category, "原分类")
                        note = db.get(desk.Selection, ("old", "article"))
                        self.assertEqual((note.note, note.favorite, note.hidden, note.keywords), ("原笔记", True, True, '["手工词"]'))
                        self.assertEqual(db.get(desk.ArticleTopics, "article").updated, 321)
                        run = db.get(desk.SyncRun, "run")
                        self.assertEqual((run.owner_id, run.started, run.finished, run.status), (admin.id, 100, 200, "success"))
                        self.assertEqual(db.get(desk.SyncRun, "orphan").owner_id, admin.id)
                    desk.migrate_workbench_owners(admin.id)
                    with factory() as db:
                        self.assertEqual(db.get(desk.Client, "manager").owner_id, manager.id)
                    with factory.begin() as db:
                        db.add(desk.Client(id="unowned-conflict", name="旧客户"))
                    with self.assertRaisesRegex(ValueError, "回滚"):
                        desk.migrate_workbench_owners(admin.id)
                    with factory() as db:
                        self.assertIsNone(db.get(desk.Client, "unowned-conflict").owner_id)
            finally:
                auth._engine = old_auth
                engine.dispose()


if __name__ == "__main__":
    unittest.main()
