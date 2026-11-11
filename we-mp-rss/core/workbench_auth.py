"""Independent workbench accounts, persistent sessions and per-operation AI limits."""

from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
import re
import secrets
import time
from urllib.parse import urlsplit
from uuid import uuid4

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import (Boolean, Column, ForeignKey, Integer, MetaData, String,
                        Table, delete, func, insert, select, update)
from sqlalchemy.exc import IntegrityError
from starlette.concurrency import run_in_threadpool


COOKIE_NAME = "eason_session"
COOKIE_PATH = "/workbench"
SHANGHAI = timezone(timedelta(hours=8))
metadata = MetaData()
users = Table("desk_users", metadata,
    Column("id", String(32), primary_key=True),
    Column("username", String(32), unique=True, nullable=False),
    Column("password_hash", String(100), nullable=False),
    Column("role", String(10), nullable=False),
    Column("active", Boolean, nullable=False, default=True),
    Column("created_at", Integer, nullable=False))
sessions = Table("desk_sessions", metadata,
    Column("token_hash", String(64), primary_key=True),
    Column("user_id", String(32), ForeignKey("desk_users.id"), nullable=False, index=True),
    Column("expires_at", Integer, nullable=False))
usage = Table("desk_ai_usage", metadata,
    Column("id", String(32), primary_key=True),
    Column("user_id", String(32), ForeignKey("desk_users.id"), nullable=False, index=True),
    Column("kind", String(40), nullable=False),
    Column("created_at", Integer, nullable=False),
    Column("day", String(10), nullable=False),
    Column("status", String(10), nullable=False))
attempts = Table("desk_login_attempts", metadata,
    Column("key_hash", String(64), primary_key=True),
    Column("window_start", Integer, nullable=False),
    Column("count", Integer, nullable=False))
_engine = None
# A dummy bcrypt comparison keeps unknown users on the same verification path.
_DUMMY_HASH = bcrypt.hashpw(secrets.token_bytes(32), bcrypt.gensalt())


@dataclass(frozen=True)
class Principal:
    id: str
    username: str
    role: str


def _setting(name, default, minimum=0):
    value = int(os.environ.get(name, default))
    if value < minimum:
        raise ValueError(f"{name} must be >= {minimum}")
    return value


def init_auth_tables(engine=None):
    """Call at startup; supplying an engine is also useful for isolated tests."""
    global _engine
    if engine is None:
        from core.config import cfg
        if cfg.get("debug", False):
            raise RuntimeError("Workbench authentication requires debug=false (SQL parameters must not be logged)")
        from core.db import DB
        engine = DB.get_engine()
    if engine.echo:
        raise RuntimeError("Workbench authentication requires SQL echo disabled")
    engine.hide_parameters = True
    _public_origin()
    _setting("EASON_SESSION_HOURS", 12, 1)
    _setting("EASON_USER_DAILY_AI_LIMIT", 30, 1)
    _setting("EASON_USER_AI_MIN_INTERVAL", 10)
    _setting("EASON_ADMIN_DAILY_AI_LIMIT", 0)
    metadata.create_all(engine)
    _engine = engine


def _db():
    if _engine is None:
        raise RuntimeError("Call init_auth_tables() before using workbench authentication")
    return _engine


@contextmanager
def _transaction():
    # The shared application engine uses AUTOCOMMIT; explicitly restore atomic writes.
    with _db().connect().execution_options(isolation_level="SERIALIZABLE") as conn:
        if conn.dialect.name == "sqlite":
            conn.exec_driver_sql("BEGIN IMMEDIATE")
        else:
            conn.begin()
        try:
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise


def _principal(row):
    return Principal(row["id"], row["username"], row["role"])


def get_user_by_username(username):
    try:
        username = _username(username)
    except ValueError:
        return None
    with _db().connect() as conn:
        row = conn.execute(select(users).where(users.c.username == username,
                           users.c.active.is_(True))).mappings().first()
    return _principal(row) if row else None


def get_user_by_id(user_id):
    with _db().connect() as conn:
        row = conn.execute(select(users).where(users.c.id == user_id,
                           users.c.active.is_(True))).mappings().first()
    return _principal(row) if row else None


def _username(value):
    if not isinstance(value, str):
        raise ValueError("用户名须为 3–32 位英文字母、数字、点、下划线或连字符")
    value = value.strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{2,31}", value):
        raise ValueError("用户名须为 3–32 位英文字母、数字、点、下划线或连字符")
    return value


def upsert_user(username, password, role, reset_password=False):
    """Create an account; existing accounts require explicit reset to change anything."""
    username = _username(username)
    if role not in ("admin", "user"):
        raise ValueError("role must be admin or user")
    if not isinstance(password, str) or not 12 <= len(password.encode("utf-8")) <= 72:
        raise ValueError("密码须为 12–72 个 UTF-8 字节")
    password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("ascii")
    with _transaction() as conn:
        row = conn.execute(select(users).where(users.c.username == username).with_for_update()).mappings().first()
        if row:
            if not reset_password:
                raise ValueError("账号已存在；如需重设密码及角色，请显式使用 --reset-password")
            conn.execute(update(users).where(users.c.id == row["id"]).values(password_hash=password_hash, role=role))
            conn.execute(delete(sessions).where(sessions.c.user_id == row["id"]))
            return Principal(row["id"], username, role)
        user_id = uuid4().hex
        try:
            conn.execute(insert(users).values(id=user_id, username=username, password_hash=password_hash,
                                             role=role, active=True, created_at=int(time.time())))
        except IntegrityError:
            raise ValueError("账号已存在；请检查用户名") from None
        return Principal(user_id, username, role)


def _public_origin(env_name="EASON_PUBLIC_ORIGIN"):
    origin = os.environ.get(env_name, "").rstrip("/")
    if not origin:
        return ""
    parsed = urlsplit(origin)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path or parsed.query or parsed.fragment):
        raise ValueError(f"{env_name} must be a single HTTPS origin without path or credentials")
    return f"https://{parsed.netloc.lower()}"


def trusted_request(request: Request):
    """Do not trust Forwarded/X-Forwarded-Host; the reverse proxy must preserve Host."""
    origin = _public_origin()
    host = request.headers.get("host", "").lower()
    if origin:
        expected = origin
        if host != urlsplit(origin).netloc.lower():
            raise HTTPException(403, "不允许的访问地址")
    else:
        allowed = {"localhost", "127.0.0.1", "::1"}
        if (request.url.hostname not in allowed or not request.client
                or request.client.host not in allowed):
            raise HTTPException(403, "未配置公网访问地址")
        expected = str(request.base_url).rstrip("/")
    supplied = request.headers.get("origin")
    if supplied is not None and supplied != expected:
        raise HTTPException(403, "不允许跨站请求")
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        if supplied != expected or request.headers.get("x-workbench") != "1":
            raise HTTPException(403, "请通过工作台页面操作")


def _token_hash(token):
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def _session_token(request):
    token = request.cookies.get(COOKIE_NAME, "")
    return token if re.fullmatch(r"[A-Za-z0-9_-]{43}", token) else ""


def get_current_user(request: Request):
    trusted_request(request)
    return get_session_user(request)


def get_session_user(request: Request):
    """Session lookup; callers must independently validate their transport boundary."""
    token = _session_token(request)
    if not token:
        raise HTTPException(401, "请登录工作台")
    with _db().connect() as conn:
        row = conn.execute(select(users).join(sessions, sessions.c.user_id == users.c.id).where(
            sessions.c.token_hash == _token_hash(token), sessions.c.expires_at > int(time.time()),
            users.c.active.is_(True))).mappings().first()
    if not row:
        raise HTTPException(401, "请重新登录工作台")
    return _principal(row)


def require_admin(user: Principal = Depends(get_current_user)):
    if user.role != "admin":
        raise HTTPException(403, "需要管理员权限")
    return user


def _limit_login(ip, username):
    """Persist both IP and account attempt windows; never trust client forwarded IP headers."""
    now = int(time.time())
    keys = sorted((hashlib.sha256(f"ip:{ip}".encode()).hexdigest(),
                   hashlib.sha256(f"user:{username}".encode()).hexdigest()))
    with _transaction() as conn:
        conn.execute(delete(attempts).where(attempts.c.window_start <= now - 300))
        for key in keys:
            row = conn.execute(select(attempts).where(attempts.c.key_hash == key).with_for_update()).mappings().first()
            if row and now - row["window_start"] < 300:
                if row["count"] >= 20:
                    raise HTTPException(429, "登录尝试过于频繁，请稍后再试", headers={"Retry-After": "300"})
                conn.execute(update(attempts).where(attempts.c.key_hash == key).values(count=row["count"] + 1))
            elif row:
                conn.execute(update(attempts).where(attempts.c.key_hash == key).values(window_start=now, count=1))
            else:
                conn.execute(insert(attempts).values(key_hash=key, window_start=now, count=1))


def _login(username, password, ip):
    try:
        username = _username(username)
    except ValueError:
        username = ""  # Invalid usernames share a throttled bucket and the same failure message.
    _limit_login(ip, username)
    try:
        raw = password.encode("utf-8") if isinstance(password, str) else b""
    except UnicodeError:
        raw = b""
    valid_length = 12 <= len(raw) <= 72
    with _db().connect() as conn:
        row = conn.execute(select(users).where(users.c.username == username)).mappings().first()
    matched = bcrypt.checkpw(raw if valid_length else b"invalid", row["password_hash"].encode() if row else _DUMMY_HASH)
    if not row or not matched or not valid_length or not row["active"]:
        raise HTTPException(401, "用户名或密码不正确")
    token = secrets.token_urlsafe(32)
    ttl = _setting("EASON_SESSION_HOURS", 12, 1) * 3600
    with _transaction() as conn:
        # Serialize with password reset/account changes before issuing a new session.
        current = conn.execute(select(users).where(users.c.id == row["id"]).with_for_update()).mappings().first()
        if not current or not current["active"] or current["password_hash"] != row["password_hash"]:
            raise HTTPException(401, "用户名或密码不正确")
        conn.execute(delete(sessions).where(sessions.c.expires_at <= int(time.time())))
        conn.execute(insert(sessions).values(token_hash=_token_hash(token), user_id=row["id"],
                                             expires_at=int(time.time()) + ttl))
    return _principal(current), token, ttl


router = APIRouter(prefix="/workbench/api/auth", tags=["工作台认证"], dependencies=[Depends(trusted_request)])


@router.post("/login")
async def login(request: Request, response: Response):
    body = await request.body()
    try:
        data = json.loads(body) if len(body) <= 4096 else None
    except (ValueError, UnicodeError):
        data = None
    if not isinstance(data, dict) or set(data) != {"username", "password"}:
        raise HTTPException(400, "登录请求格式错误")
    ip = request.client.host if request.client else "unknown"
    user, token, ttl = await run_in_threadpool(_login, data["username"], data["password"], ip)
    response.set_cookie(COOKIE_NAME, token, max_age=ttl, path=COOKIE_PATH,
                        httponly=True, secure=bool(_public_origin()), samesite="lax")
    response.headers["Cache-Control"] = "no-store"
    return {"authenticated": True, "user": asdict(user)}


@router.post("/logout")
def logout(request: Request, response: Response):
    token = _session_token(request)
    if token:
        with _transaction() as conn:
            conn.execute(delete(sessions).where(sessions.c.token_hash == _token_hash(token)))
    response.delete_cookie(COOKIE_NAME, path=COOKIE_PATH, httponly=True,
                           secure=bool(_public_origin()), samesite="lax")
    response.headers["Cache-Control"] = "no-store"
    return {"authenticated": False}


@router.get("/session")
def session(response: Response, user: Principal = Depends(get_current_user)):
    response.headers["Cache-Control"] = "no-store"
    return {"authenticated": True, "user": asdict(user)}


def reserve_ai_usage(user: Principal, kind: str):
    """Reserve once per user operation, before the first model call. Failures still count."""
    if not isinstance(kind, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,39}", kind):
        raise ValueError("Invalid AI operation kind")
    actor_id = getattr(user, "actor_id", user.id)
    if actor_id != user.id:
        user = get_user_by_id(actor_id)
        if user is None:
            raise HTTPException(401, "请重新登录工作台")
    now = int(time.time())
    day = datetime.fromtimestamp(now, SHANGHAI).date().isoformat()
    with _transaction() as conn:
        row = conn.execute(select(users).where(users.c.id == user.id).with_for_update()).mappings().first()
        if not row or not row["active"]:
            raise HTTPException(401, "请重新登录工作台")
        limit = (_setting("EASON_ADMIN_DAILY_AI_LIMIT", 0) if row["role"] == "admin"
                 else _setting("EASON_USER_DAILY_AI_LIMIT", 30, 1))
        interval = _setting("EASON_USER_AI_MIN_INTERVAL", 10) if kind != "keywords" else 0
        last = conn.execute(select(func.max(usage.c.created_at)).where(usage.c.user_id == user.id, usage.c.kind != "keywords")).scalar()
        if last is not None and now - last < interval:
            raise HTTPException(429, "AI 操作过于频繁，请稍后再试",
                                headers={"Retry-After": str(max(1, interval - (now - last)))})
        count = conn.execute(select(func.count()).select_from(usage).where(
            usage.c.user_id == user.id, usage.c.day == day)).scalar_one()
        if limit and count >= limit:
            raise HTTPException(429, "今日 AI 操作额度已用完（北京时间零点重置）")
        usage_id = uuid4().hex
        conn.execute(insert(usage).values(id=usage_id, user_id=user.id, kind=kind,
                                         created_at=now, day=day, status="reserved"))
    return usage_id


def finish_ai_usage(usage_id: str, success: bool):
    with _transaction() as conn:
        conn.execute(update(usage).where(usage.c.id == usage_id, usage.c.status == "reserved").values(
            status="succeeded" if success else "failed"))
