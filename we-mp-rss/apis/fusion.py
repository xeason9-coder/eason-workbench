"""Loopback-only service API consumed by the KB server, never by browsers directly."""
from dataclasses import asdict
import json
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.exc import IntegrityError
from starlette.concurrency import run_in_threadpool

from apis import workbench as legacy
from core import fusion
from core import workbench as desk
from core import workbench_auth as auth


router = APIRouter(prefix="/fusion", dependencies=[Depends(fusion.trusted_service)])


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class LoginInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(max_length=100)
    password: str = Field(max_length=100)


class UserInput(LoginInput):
    role: Literal["admin", "user"] = "user"


class UserStatus(Input):
    active: bool


class Grants(Input):
    documents: list[str] = Field(default_factory=list, max_length=1000)
    tasks: list[str] = Field(default_factory=list, max_length=1000)
    articles: list[str] = Field(default_factory=list, max_length=1000)


class MemberInput(Input):
    user_id: str = Field(min_length=1, max_length=32)
    role: Literal["manager", "member", "external"]
    grants: Grants = Field(default_factory=Grants)


@router.post("/auth/login")
async def login(data: LoginInput, request: Request, response: Response):
    secure = bool(auth._public_origin("FUSION_PUBLIC_ORIGIN"))
    user, token, ttl = await run_in_threadpool(auth._login, data.username, data.password, request.client.host)
    response.set_cookie(auth.COOKIE_NAME, token, max_age=ttl, path="/", httponly=True,
                        secure=secure, samesite="lax")
    response.headers["Cache-Control"] = "no-store"
    # A stale client's cookie must not turn a successful login into an error.
    return {"authenticated": True, "user": asdict(user), "clients": fusion.clients_for(user), "client": None}


@router.post("/auth/logout")
def logout(request: Request, response: Response):
    token = auth._session_token(request)
    if token:
        with auth._transaction() as conn:
            conn.execute(delete(auth.sessions).where(auth.sessions.c.token_hash == auth._token_hash(token)))
    response.delete_cookie(auth.COOKIE_NAME, path="/", httponly=True, samesite="lax",
                           secure=bool(auth._public_origin("FUSION_PUBLIC_ORIGIN")))
    return {"authenticated": False}


@router.get("/auth/session")
def session(request: Request, response: Response, user=Depends(fusion.current_user)):
    response.headers["Cache-Control"] = "no-store"
    return fusion.session_payload(request, user)


@router.get("/internal/clients")
def active_client_ids():
    with auth._db().connect() as conn:
        return {"active_ids": list(conn.execute(select(desk.Client.id).where(
            desk.Client.archived.is_(False), desk.Client.owner_id.is_not(None),
            desk.Client.owner_id != "")).scalars())}


@router.get("/admin/users")
def list_users(user=Depends(fusion.admin_user)):
    with auth._db().connect() as conn:
        return {"items": [dict(row) for row in conn.execute(select(
            auth.users.c.id, auth.users.c.username, auth.users.c.role, auth.users.c.active,
            auth.users.c.created_at).order_by(auth.users.c.username)).mappings()]}


@router.post("/admin/users")
async def create_user(data: UserInput, user=Depends(fusion.admin_user)):
    try:
        created = await run_in_threadpool(auth.upsert_user, data.username, data.password, data.role)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return {"user": asdict(created)}


@router.put("/admin/users/{user_id}")
def set_user_status(user_id: str, data: UserStatus, user=Depends(fusion.admin_user)):
    if user_id == user.id and not data.active:
        raise HTTPException(400, "不能停用当前管理员账号")
    with auth._transaction() as conn:
        existing = conn.execute(select(auth.users.c.id).where(auth.users.c.id == user_id)).first()
        if not existing:
            raise HTTPException(404, "账号不存在")
        conn.execute(update(auth.users).where(auth.users.c.id == user_id).values(active=data.active))
        if not data.active:
            conn.execute(delete(auth.sessions).where(auth.sessions.c.user_id == user_id))
    return {"ok": True}


@router.get("/clients")
def clients(include_archived: bool = False, user=Depends(fusion.current_user)):
    return {"items": fusion.clients_for(user, include_archived=include_archived)}


@router.post("/clients")
def create_client(data: legacy.ClientInput, user=Depends(fusion.current_user)):
    if data.archived:
        raise HTTPException(400, "新客户不能直接归档")
    try:
        with auth._transaction() as conn:
            total = conn.execute(select(func.count()).select_from(desk.Client.__table__).where(
                desk.Client.owner_id == user.id, desk.Client.archived.is_(False))).scalar_one()
            if total >= 2:
                raise HTTPException(409, "每个账号最多创建两个未归档客户空间")
            client_id = uuid4().hex
            conn.execute(insert(desk.Client.__table__).values(id=client_id, owner_id=user.id,
                                                           **data.model_dump()))
    except IntegrityError:
        raise HTTPException(409, "已有同名客户") from None
    return fusion.access(user, client_id)[0]


@router.put("/clients/{client_id}")
def edit_client(client_id: str, data: legacy.ClientInput, user=Depends(fusion.current_user)):
    table = desk.Client.__table__
    try:
        # BEGIN IMMEDIATE serializes local create/restore capacity checks with the write.
        with auth._transaction() as conn:
            client = conn.execute(select(table).where(table.c.id == client_id)).mappings().first()
            if not client or not client["owner_id"] or (client["archived"] and
                    user.role != "admin" and client["owner_id"] != user.id):
                raise HTTPException(404, "客户不存在")
            if user.role != "admin":
                role = conn.execute(select(fusion.members.c.role).where(
                    fusion.members.c.client_id == client_id, fusion.members.c.user_id == user.id)).scalar_one_or_none()
                if client["owner_id"] != user.id and role is None:
                    raise HTTPException(404, "客户不存在")
                if client["owner_id"] != user.id and role != "manager":
                    raise HTTPException(403, "需要客户管理员权限")
                if data.archived != client["archived"] and client["owner_id"] != user.id:
                    raise HTTPException(403, "仅空间创建者或系统管理员可归档或恢复客户")
            if client["archived"] and not data.archived:
                total = conn.execute(select(func.count()).select_from(table).where(
                    table.c.owner_id == client["owner_id"], table.c.archived.is_(False))).scalar_one()
                if total >= 2:
                    raise HTTPException(409, "该空间创建者已有两个未归档客户空间")
            duplicate = conn.execute(select(table.c.id).where(table.c.owner_id == client["owner_id"],
                table.c.name == data.name, table.c.id != client_id)).first()
            if duplicate:
                raise HTTPException(409, "已有同名客户")
            conn.execute(update(table).where(table.c.id == client_id).values(**data.model_dump()))
    except IntegrityError:
        raise HTTPException(409, "已有同名客户") from None
    if data.archived:
        return {"id": client_id, **data.model_dump(), "role": "manager", "grants": fusion.empty_grants()}
    return dict(fusion.access(user, client_id)[0], archived=False)


def require_manager(user, client_id):
    client, owner_id = fusion.access(user, client_id)
    if client["role"] != "manager":
        raise HTTPException(403, "需要客户管理员权限")
    return owner_id


@router.get("/clients/{client_id}/members")
def list_members(client_id: str, user=Depends(fusion.current_user)):
    owner_id = require_manager(user, client_id)
    with auth._db().connect() as conn:
        rows = conn.execute(select(fusion.members, auth.users.c.username, auth.users.c.active).join(
            auth.users, fusion.members.c.user_id == auth.users.c.id).where(
                fusion.members.c.client_id == client_id)).mappings()
        items = [dict(row, grants=json.loads(row["grants"])) for row in rows]
    return {"owner_id": owner_id, "items": items}


@router.put("/clients/{client_id}/members")
def set_member(client_id: str, data: MemberInput, user=Depends(fusion.current_user)):
    owner_id = require_manager(user, client_id)
    if data.user_id == owner_id:
        raise HTTPException(400, "现有客户所有者不通过成员授权迁移")
    if not auth.get_user_by_id(data.user_id):
        raise HTTPException(404, "有效账号不存在")
    grants = data.grants.model_dump()
    if any(not value or len(value) > 255 for values in grants.values() for value in values):
        raise HTTPException(400, "授权内容 ID 格式错误")
    if grants["articles"]:
        scoped = fusion.ScopedPrincipal(owner_id, user.username, "user", user.id, client_id)
        with desk.Session() as db:
            for article_id in grants["articles"]:
                try:
                    desk.article_row(db, client_id, article_id, user=scoped)
                except ValueError:
                    raise HTTPException(400, "授权文章不属于此客户") from None
    # Document/task ids belong to KB storage; the KB server verifies those before forwarding.
    values = dict(role=data.role, grants=json.dumps(grants, ensure_ascii=False))
    with auth._transaction() as conn:
        where = (fusion.members.c.client_id == client_id, fusion.members.c.user_id == data.user_id)
        if conn.execute(select(fusion.members.c.user_id).where(*where)).first():
            conn.execute(update(fusion.members).where(*where).values(**values))
        else:
            conn.execute(insert(fusion.members).values(client_id=client_id, user_id=data.user_id, **values))
    return {"ok": True}


@router.delete("/clients/{client_id}/members/{user_id}")
def remove_member(client_id: str, user_id: str, user=Depends(fusion.current_user)):
    require_manager(user, client_id)
    with auth._transaction() as conn:
        conn.execute(delete(fusion.members).where(fusion.members.c.client_id == client_id,
                                                 fusion.members.c.user_id == user_id))
    return {"ok": True}


monitor = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
monitor.dependency_overrides[auth.get_current_user] = fusion.scoped_user
monitor.dependency_overrides[auth.require_admin] = fusion.admin_user
monitor.add_api_route("/state", fusion.monitor_state, methods=["GET"])


@monitor.get("/settings")
def get_settings(user=Depends(fusion.admin_user)):
    return desk.public_settings()

# Keep existing validators and response handling, exposing only these explicitly approved routes.
MONITOR_PATHS = {
    "/articles", "/article", "/article/reader", "/export", "/sync", "/keywords", "/chat",
    "/clients/{client_id}/sources", "/clients/{client_id}/sources/{feed_id}",
    "/settings", "/model-test", "/weread/shelf", "/weread/search", "/wechat/search",
    "/wechat/qr", "/wechat/status", "/wechat/qr-image", "/weread/qr", "/weread/status", "/weread/qr-image",
}
ADMIN_PATHS = {"settings", "model-test", "weread/shelf", "weread/search",
               "wechat/qr", "wechat/status", "wechat/qr-image", "weread/qr", "weread/status", "weread/qr-image"}
for route in legacy.router.routes:
    path = route.path.removeprefix("/workbench/api")
    if path in MONITOR_PATHS:
        monitor.add_api_route(path, route.endpoint, methods=list(route.methods))


@monitor.middleware("http")
async def monitor_boundary(request: Request, call_next):
    try:
        actor = fusion.current_user(request)
        path = request.url.path.split("/fusion/monitor/", 1)[-1].lstrip("/")
        if path in ADMIN_PATHS:
            fusion.admin_user(request)
        else:
            client, _ = fusion.selected_access(request, actor)
            supplied = request.query_params.getlist("client_id")
            if any(value != client["id"] for value in supplied):
                raise HTTPException(404, "客户不存在")
            if path.startswith("clients/") and path.split("/")[1] != client["id"]:
                raise HTTPException(404, "客户不存在")
            if path in {"article", "article/reader"} and request.query_params.get("article_id"):
                with desk.Session() as db:
                    try:
                        desk.article_row(db, client["id"], request.query_params["article_id"],
                                         user=fusion.scoped_user(request))
                    except ValueError:
                        raise HTTPException(404, "文章不存在或未授权") from None
            if request.method not in ("GET", "HEAD"):
                raw = await request.body()
                if len(raw) > 65536:
                    raise HTTPException(413, "请求过大")
                try:
                    body = json.loads(raw) if raw else {}
                except ValueError:
                    raise HTTPException(400, "请求格式错误") from None
                if not isinstance(body, dict):
                    raise HTTPException(400, "请求格式错误")
                if body.get("client_id", client["id"]) != client["id"]:
                    raise HTTPException(404, "客户不存在")
            if client["role"] == "external":
                if not (request.method == "GET" and path in {"state", "articles", "article", "article/reader", "export"}
                        or request.method == "POST" and path == "chat"):
                    raise HTTPException(403, "外部成员仅可阅读明确授权内容")
        response = await call_next(request)
        if response.headers.get("content-type", "").startswith("application/json"):
            body = b"".join([part async for part in response.body_iterator])
            body = body.replace(b"/workbench/api/", b"/api/fusion/monitor/")
            headers = dict(response.headers)
            headers.pop("content-length", None)
            response = Response(body, response.status_code, headers=headers,
                                background=response.background)
        response.headers["Cache-Control"] = "no-store"
        return response
    except HTTPException as exc:
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code, headers=exc.headers)
