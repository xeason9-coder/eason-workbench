"""Local KB bridge: persistent memberships and scoped legacy workbench access."""
from dataclasses import asdict, dataclass
import ipaddress
import json
import os
from pathlib import Path
import secrets
import threading

from fastapi import HTTPException, Request
from sqlalchemy import Column, MetaData, String, Table, Text, select

from core import workbench as desk
from core import workbench_auth as auth


metadata = MetaData()
members = Table("fusion_client_members", metadata,
    Column("client_id", String(40), primary_key=True),
    Column("user_id", String(32), primary_key=True),
    Column("role", String(10), nullable=False),
    Column("grants", Text, nullable=False, default='{"documents":[],"tasks":[],"articles":[]}'))
KEY_PATH = Path("data/fusion-service.key")
_key_lock = threading.Lock()


@dataclass(frozen=True)
class ScopedPrincipal(auth.Principal):
    actor_id: str
    client_id: str
    article_ids: tuple | None = None


def service_key():
    value = os.environ.get("FUSION_SERVICE_TOKEN", "")
    if not value:
        with _key_lock:
            KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
            if not KEY_PATH.exists():
                try:
                    fd = os.open(KEY_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                except FileExistsError:
                    pass
                else:
                    with os.fdopen(fd, "w", encoding="ascii") as stream:
                        stream.write(secrets.token_urlsafe(48))
            value = KEY_PATH.read_text(encoding="ascii").strip()
    if len(value.encode("utf-8")) < 32 or not value.isascii() or any(c.isspace() for c in value):
        raise RuntimeError("FUSION_SERVICE_TOKEN must contain at least 32 ASCII bytes without whitespace")
    return value


def init_fusion():
    service_key()
    metadata.create_all(auth._db())


def trusted_service(request: Request):
    try:
        local = request.client and ipaddress.ip_address(request.client.host).is_loopback
    except ValueError:
        local = False
    supplied = request.headers.get("authorization", "")
    expected = "Bearer " + service_key()
    if not local or not secrets.compare_digest(supplied.encode("utf-8"), expected.encode("ascii")):
        raise HTTPException(403, "仅允许受信本地服务访问")


def current_user(request: Request):
    trusted_service(request)
    return auth.get_session_user(request)


def admin_user(request: Request):
    user = current_user(request)
    if user.role != "admin":
        raise HTTPException(403, "需要管理员权限")
    return user


def empty_grants():
    return {"documents": [], "tasks": [], "articles": []}


def access(user, client_id):
    with desk.Session() as db:
        client = db.get(desk.Client, client_id)
        if not client or client.archived or not client.owner_id:
            raise HTTPException(404, "客户不存在或未分配所有者")
        member = db.execute(select(members).where(members.c.client_id == client_id,
                            members.c.user_id == user.id)).mappings().first()
        if user.role == "admin" or client.owner_id == user.id:
            role, grants = "manager", empty_grants()
        elif member:
            role, grants = member["role"], json.loads(member["grants"])
        else:
            raise HTTPException(404, "客户不存在")
        return {"id": client.id, "name": client.name, "description": client.description or "",
                "role": role, "grants": grants, "owned": client.owner_id == user.id}, client.owner_id


def clients_for(user, include_archived=False):
    with desk.Session() as db:
        query = db.query(desk.Client).order_by(desk.Client.name)
        if not include_archived:
            query = query.filter(desk.Client.archived.is_(False))
        clients = query.all()
    result = []
    for client in clients:
        if client.archived:
            if user.role != "admin" and client.owner_id != user.id:
                continue
            result.append({"id": client.id, "name": client.name, "description": client.description or "",
                           "archived": True, "role": "manager", "grants": empty_grants(),
                           "owned": client.owner_id == user.id})
            continue
        try:
            item = access(user, client.id)[0]
            result.append(dict(item, archived=False) if include_archived else item)
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
    return result


def session_payload(request, user):
    clients = clients_for(user)
    active_id = request.headers.get("x-fusion-client", "")
    client = access(user, active_id)[0] if active_id else None
    return {"authenticated": True, "user": asdict(user), "clients": clients, "client": client}


def selected_access(request, user):
    client_id = request.headers.get("x-fusion-client", "")
    if not client_id:
        raise HTTPException(400, "请先选择客户空间")
    return access(user, client_id)


def scoped_user(request: Request):
    actor = current_user(request)
    client, owner_id = selected_access(request, actor)
    # Legacy code uses the owner's id only after membership validation; billing uses actor_id.
    return ScopedPrincipal(owner_id, actor.username, "user", actor.id, client["id"],
                           tuple(client["grants"]["articles"]) if client["role"] == "external" else None)


def monitor_state(request: Request):
    actor = current_user(request)
    client, _ = selected_access(request, actor)
    user = scoped_user(request)
    with desk.Session() as db:
        sources = []
        if client["role"] != "external":
            for binding, feed in db.query(desk.Source, desk.Feed).join(desk.Feed, desk.Source.feed_id == desk.Feed.id).filter(
                    desk.Source.client_id == client["id"]).all():
                sources.append({"id": feed.id, "name": feed.mp_name, "category": binding.category,
                                "enabled": binding.enabled, "synced_at": desk.iso(feed.sync_time)})
        counts = {name: desk.article_query(db, client["id"], days=days, view=view, user=user).count()
                  for name, days, view in [("recent", 7, "recent"), ("all", 0, "all"),
                                           ("favorites", 0, "favorites"), ("excluded", 0, "excluded")]}
        runs = [] if client["role"] == "external" else [
            {"id": r.id, "client_id": r.client_id, "status": r.status, "started_at": desk.iso(r.started),
             "finished_at": desk.iso(r.finished), "results": json.loads(r.results or "[]")}
            for r in db.query(desk.SyncRun).filter(desk.SyncRun.client_id == client["id"]).order_by(
                desk.SyncRun.started.desc()).limit(12)]
    public = desk.public_settings()
    keyword_status = desk._keyword_status.get(user.id, {})
    if keyword_status.get("client_id") != client["id"] or client["role"] == "external":
        keyword_status = {"running": False, "message": ""}
    job = desk.scheduler.get_job("desk-daily")
    return {"version": desk.DESK_VERSION, "user": asdict(actor),
            "clients": [dict(client, archived=False, sources=sources, counts=counts)],
            "available_sources": [{"id": s["id"], "name": s["name"]} for s in sources], "runs": runs,
            "sync_running": any(r["status"] == "running" for r in runs),
            "keywords": dict(keyword_status),
            "next_run": job.next_run_time.isoformat() if job and desk.scheduler.running else None,
            "settings": public if actor.role == "admin" else {k: public[k] for k in (
                "brand", "key_configured", "daily_time", "daily_enabled")}}
