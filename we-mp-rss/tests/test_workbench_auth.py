import concurrent.futures
from datetime import datetime
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, update
from starlette.requests import Request

from core import workbench_auth as auth


class WorkbenchAuthTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        env = patch.dict(os.environ, {
            "EASON_PUBLIC_ORIGIN": "https://desk.example.test",
            "EASON_SESSION_HOURS": "12",
            "EASON_USER_DAILY_AI_LIMIT": "3",
            "EASON_ADMIN_DAILY_AI_LIMIT": "0",
            "EASON_USER_AI_MIN_INTERVAL": "0",
        })
        env.start()
        self.addCleanup(env.stop)
        self.engine = create_engine("sqlite:///" + str(Path(self.temp.name) / "auth.db"),
                                    isolation_level="AUTOCOMMIT",
                                    connect_args={"check_same_thread": False, "timeout": 10})
        self.addCleanup(self.engine.dispose)
        previous_engine = auth._engine
        self.addCleanup(setattr, auth, "_engine", previous_engine)
        auth.init_auth_tables(self.engine)
        # Fictional test credentials, never used to initialize deployment accounts.
        self.password = "test-only-password-123"
        self.user = auth.upsert_user("manager", self.password, "user")
        self.admin = auth.upsert_user("eason", self.password, "admin")
        app = FastAPI()
        app.include_router(auth.router)

        @app.get("/workbench/api/admin-test")
        def admin_only(user=Depends(auth.require_admin)):
            return {"id": user.id}

        self.client = TestClient(app, base_url="https://desk.example.test")
        self.addCleanup(self.client.close)
        self.headers = {"Origin": "https://desk.example.test", "X-Workbench": "1"}

    def login(self, username="manager", password=None, headers=None):
        return self.client.post("/workbench/api/auth/login", headers=headers or self.headers,
                                json={"username": username, "password": password or self.password})

    def test_anonymous_login_logout_and_safe_session(self):
        self.assertEqual(self.client.get("/workbench/api/auth/session").status_code, 401)
        response = self.login()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"authenticated": True, "user": {
            "id": self.user.id, "username": "manager", "role": "user"}})
        cookie = response.headers["set-cookie"]
        for flag in ("HttpOnly", "Secure", "SameSite=lax", "Max-Age=43200", "Path=/workbench"):
            self.assertIn(flag, cookie)
        token = self.client.cookies.get(auth.COOKIE_NAME)
        with self.engine.connect() as conn:
            row = conn.execute(select(auth.sessions)).mappings().one()
        self.assertNotEqual(row["token_hash"], token)
        self.assertEqual(row["token_hash"], auth._token_hash(token))
        session = self.client.get("/workbench/api/auth/session")
        self.assertEqual(session.json(), response.json())
        for secret in (token, self.password, "password_hash"):
            self.assertNotIn(secret, session.text)
        self.assertEqual(self.client.post("/workbench/api/auth/logout", headers=self.headers).status_code, 200)
        self.assertEqual(self.client.get("/workbench/api/auth/session").status_code, 401)
        self.client.cookies.set(auth.COOKIE_NAME, token, path="/workbench")
        self.assertEqual(self.client.get("/workbench/api/auth/session").status_code, 401)

    def test_wrong_password_unknown_user_and_rate_limit(self):
        wrong = self.login(password="wrong-password-123")
        unknown = self.login(username="missing")
        self.assertEqual(wrong.status_code, 401)
        self.assertEqual(wrong.json(), unknown.json())
        with patch.object(auth.bcrypt, "checkpw", return_value=False):
            for _ in range(18):
                self.assertEqual(self.login(username="missing").status_code, 401)
            self.assertEqual(self.login(username="missing").status_code, 429)
        auth.init_auth_tables(self.engine)
        self.assertEqual(self.login(username="missing").status_code, 429)

    def test_expiry_role_active_and_reset_invalidate_sessions(self):
        self.login()
        self.assertEqual(self.client.get("/workbench/api/admin-test").status_code, 403)
        with self.engine.begin() as conn:
            conn.execute(update(auth.sessions).values(expires_at=1))
        self.assertEqual(self.client.get("/workbench/api/auth/session").status_code, 401)
        self.login("eason")
        self.assertEqual(self.client.get("/workbench/api/admin-test").status_code, 200)
        with self.assertRaises(ValueError):
            auth.upsert_user("eason", "a-different-password", "user")
        auth.upsert_user("eason", "a-different-password", "admin", reset_password=True)
        self.assertEqual(self.client.get("/workbench/api/auth/session").status_code, 401)
        self.login("eason", "a-different-password")
        with self.engine.begin() as conn:
            conn.execute(update(auth.users).where(auth.users.c.id == self.admin.id).values(active=False))
        self.assertEqual(self.client.get("/workbench/api/auth/session").status_code, 401)
        self.assertIsNone(auth.get_user_by_id(self.admin.id))
        self.assertEqual(auth.get_user_by_username("Manager"), self.user)
        self.assertIsNone(auth.get_user_by_username("../invalid"))

    def test_trusted_host_origin_and_local_mode(self):
        for headers in ({"X-Workbench": "1"}, {"Origin": "https://desk.example.test"},
                        {"Origin": "https://evil.test", "X-Workbench": "1"},
                        {**self.headers, "Host": "evil.test", "X-Forwarded-Host": "desk.example.test"}):
            self.assertEqual(self.login(headers=headers).status_code, 403)
        with patch.dict(os.environ, {"EASON_PUBLIC_ORIGIN": ""}):
            request = Request({"type": "http", "method": "POST", "scheme": "http", "path": "/workbench/api/auth/login",
                "query_string": b"", "root_path": "", "server": ("localhost", 8000), "client": ("127.0.0.1", 12),
                "headers": [(b"host", b"localhost:8000"), (b"origin", b"http://localhost:8000"), (b"x-workbench", b"1")]})
            auth.trusted_request(request)
            request.scope["client"] = ("192.0.2.1", 12)
            with self.assertRaises(HTTPException):
                auth.trusted_request(request)

    def test_quota_concurrency_failure_and_admin(self):
        def reserve(_):
            try:
                return auth.reserve_ai_usage(self.user, "chat")
            except HTTPException as exc:
                self.assertEqual(exc.status_code, 429)
                return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            ids = [value for value in pool.map(reserve, range(12)) if value]
        self.assertEqual(len(ids), 3)
        auth.finish_ai_usage(ids[0], False)
        auth.finish_ai_usage(ids[1], True)
        with self.assertRaises(HTTPException):
            auth.reserve_ai_usage(self.user, "summary")
        with self.assertRaises(HTTPException):
            auth.reserve_ai_usage(auth.Principal(self.user.id, "manager", "admin"), "chat")
        with self.assertRaises(ValueError):
            auth.reserve_ai_usage(self.user, "invalid/kind")
        for _ in range(4):
            auth.finish_ai_usage(auth.reserve_ai_usage(self.admin, "chat"), True)
        with self.engine.connect() as conn:
            statuses = conn.execute(select(auth.usage.c.status).where(auth.usage.c.user_id == self.user.id)).scalars().all()
        self.assertCountEqual(statuses, ["failed", "succeeded", "reserved"])

    def test_frequency_and_shanghai_midnight(self):
        before = int(datetime(2026, 11, 10, 23, 59, 59, tzinfo=auth.SHANGHAI).timestamp())
        with patch.dict(os.environ, {"EASON_USER_DAILY_AI_LIMIT": "1", "EASON_USER_AI_MIN_INTERVAL": "10"}):
            with patch.object(auth.time, "time", return_value=before):
                auth.reserve_ai_usage(self.user, "chat")
            with patch.object(auth.time, "time", return_value=before + 2):
                with self.assertRaises(HTTPException) as caught:
                    auth.reserve_ai_usage(self.user, "chat")
                self.assertEqual(caught.exception.headers["Retry-After"], "8")
            with patch.object(auth.time, "time", return_value=before + 10):
                auth.reserve_ai_usage(self.user, "chat")
                with self.assertRaises(HTTPException):
                    auth.reserve_ai_usage(self.user, "chat")
        with self.engine.connect() as conn:
            days = conn.execute(select(auth.usage.c.day)).scalars().all()
        self.assertEqual(days, ["2026-11-10", "2026-11-11"])


if __name__ == "__main__":
    unittest.main()
