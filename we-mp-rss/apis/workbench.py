import base64
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response, RedirectResponse
from pydantic import BaseModel, Field, ConfigDict
from sqlalchemy.exc import IntegrityError

from core import workbench as desk
from core import workbench_auth as auth
from core.models import Feed


router = APIRouter(prefix="/workbench", tags=["信源工作台"])

class Input(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class ClientInput(Input):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=300)
    archived: bool = False


class SourceInput(Input):
    name: str = Field(min_length=1, max_length=100)
    identifier: str = Field(min_length=1, max_length=2000)
    category: str = Field(default="行业观察", min_length=1, max_length=50)
    enabled: bool = True


class SourceEdit(Input):
    category: str = Field(min_length=1, max_length=50)
    enabled: bool


class SelectionInput(Input):
    favorite: bool | None = None
    hidden: bool | None = None
    keywords: list[str] | None = Field(default=None, max_length=12)
    note: str | None = Field(default=None, max_length=2000)


class SettingsInput(Input):
    brand: str = Field(min_length=1, max_length=30)
    model: Literal["standard", "advanced"]
    api_key: str = Field(default="", max_length=256)
    clear_key: bool = False
    weread_api_key: str = Field(default="", max_length=512)
    clear_weread_key: bool = False
    daily_time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    daily_enabled: bool = True


class SyncInput(Input):
    client_id: str = Field(min_length=1, max_length=40)
    source_id: str = Field(default="", max_length=255)


class HistoryItem(Input):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=6000)


class ChatInput(Input):
    client_id: str = Field(min_length=1, max_length=40)
    message: str = Field(min_length=1, max_length=2000)
    history: list[HistoryItem] = Field(default_factory=list, max_length=6)


def fail(exc):
    raise HTTPException(400, str(exc)) from None


@router.get("/", include_in_schema=False)
def page(request: Request):
    try:
        auth.get_current_user(request)
    except HTTPException as exc:
        if exc.status_code == 401:
            return RedirectResponse("/workbench/login", status_code=303)
        raise
    return FileResponse("public/workbench/index.html", headers={
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; "
            "frame-src 'self'; "
            "frame-ancestors 'none'; form-action 'self'",
        "Referrer-Policy": "no-referrer",
    })


@router.get("/assets/{name}", include_in_schema=False)
def asset(name: str):
    if name not in ("desk.js", "desk.css", "login.js"):
        raise HTTPException(404)
    return FileResponse(Path("public/workbench") / name, headers={"Cache-Control": "no-cache"})


@router.get("/api/state")
def state(user=Depends(auth.get_current_user)):
    return desk.get_state(user)


@router.post("/api/clients")
def create_client(data: ClientInput, user=Depends(auth.get_current_user)):
    try:
        with desk.Session.begin() as db:
            new_id = uuid4().hex
            db.add(desk.Client(id=new_id, owner_id=user.id, **data.model_dump()))
        return {"id": new_id}
    except IntegrityError:
        raise HTTPException(409, "已有同名客户；如已归档，可在客户管理中恢复") from None


@router.put("/api/clients/{client_id}")
def edit_client(client_id: str, data: ClientInput, user=Depends(auth.get_current_user)):
    try:
        with desk.Session.begin() as db:
            client = db.get(desk.Client, client_id)
            if not client or client.owner_id != user.id:
                raise HTTPException(404, "客户不存在")
            for key, value in data.model_dump().items():
                setattr(client, key, value)
        return {"ok": True}
    except IntegrityError:
        raise HTTPException(409, "已有同名客户") from None


@router.post("/api/clients/{client_id}/sources")
def add_source(client_id: str, data: SourceInput, user=Depends(auth.get_current_user)):
    try:
        feed_id = desk.parse_source_id(data.identifier)
        with desk.Session.begin() as db:
            desk.require_client(db, client_id, user)
            if db.get(desk.Source, (client_id, feed_id)):
                raise ValueError("此公众号已属于当前客户")
            feed = db.get(Feed, feed_id)
            if not feed:
                now = datetime.now()
                feed = Feed(id=feed_id, mp_name=data.name, mp_intro="", mp_cover="", status=1,
                    created_at=now, updated_at=now, sync_time=0, update_time=0,
                    faker_id=base64.b64encode(feed_id.removeprefix("MP_WXS_").encode()).decode())
                db.add(feed)
            db.add(desk.Source(client_id=client_id, feed_id=feed_id,
                               category=data.category, enabled=data.enabled))
        desk.apply_promotion_exclusions(client_id, feed_id, user=user)
        return {"id": feed_id, "message": "来源已保存，点击更新验证采集"}
    except ValueError as exc:
        fail(exc)


@router.put("/api/clients/{client_id}/sources/{feed_id}")
def edit_source(client_id: str, feed_id: str, data: SourceEdit, user=Depends(auth.get_current_user)):
    with desk.Session.begin() as db:
        client = db.get(desk.Client, client_id)
        if not client or client.owner_id != user.id:
            raise HTTPException(404, "客户不存在")
        binding = db.get(desk.Source, (client_id, feed_id))
        if not binding:
            raise HTTPException(404, "来源不存在")
        binding.category, binding.enabled = data.category, data.enabled
    return {"ok": True}


@router.delete("/api/clients/{client_id}/sources/{feed_id}")
def remove_source(client_id: str, feed_id: str, user=Depends(auth.get_current_user)):
    with desk.Session.begin() as db:
        client = db.get(desk.Client, client_id)
        if not client or client.owner_id != user.id:
            raise HTTPException(404, "客户不存在")
        binding = db.get(desk.Source, (client_id, feed_id))
        if not binding:
            raise HTTPException(404, "来源不存在")
        db.delete(binding)
    return {"ok": True}


@router.get("/api/articles")
def list_articles(client_id: str, q: str = Query("", max_length=120),
                  days: int = Query(7, ge=0, le=365), source_id: str = "",
                  view: Literal["recent", "all", "favorites", "excluded"] = "recent",
                  page: int = Query(1, ge=1), limit: int = Query(20, ge=1, le=100), user=Depends(auth.get_current_user)):
    try:
        return desk.articles(client_id, q, days, source_id, view, page, limit, user=user)
    except ValueError as exc:
        fail(exc)


@router.get("/api/article")
def get_article(client_id: str, article_id: str, user=Depends(auth.get_current_user)):
    try:
        return desk.article_detail(client_id, article_id, user=user)
    except ValueError as exc:
        fail(exc)


@router.get("/api/article/reader", include_in_schema=False)
def read_article(client_id: str, article_id: str, user=Depends(auth.get_current_user)):
    try:
        with desk.Session() as db:
            article = desk.article_row(db, client_id, article_id, user=user)[0]
            document = desk.reader_document(article.content or article.content_html or "")
        return Response(document, media_type="text/html", headers={
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; "
                "img-src https://mmbiz.qpic.cn https://mmbiz.qlogo.cn https://res.wx.qq.com; "
                "sandbox allow-same-origin; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
            "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        })
    except ValueError as exc:
        fail(exc)


@router.put("/api/article")
def edit_article(client_id: str, article_id: str, data: SelectionInput, user=Depends(auth.get_current_user)):
    try:
        desk.article_detail(client_id, article_id, user=user)
        with desk.Session.begin() as db:
            selection = db.get(desk.Selection, (client_id, article_id))
            if not selection:
                selection = desk.Selection(client_id=client_id, article_id=article_id)
                db.add(selection)
            for key, value in data.model_dump(exclude_none=True).items():
                if key == "keywords":
                    value = json.dumps(list(dict.fromkeys(x.strip()[:40] for x in value if x.strip())),
                                       ensure_ascii=False)
                setattr(selection, key, value)
        return {"ok": True}
    except ValueError as exc:
        fail(exc)


@router.get("/api/export")
def export(client_id: str, q: str = Query("", max_length=120),
           days: int = Query(7, ge=0, le=365), source_id: str = "",
           view: Literal["recent", "all", "favorites", "excluded"] = "recent", user=Depends(auth.get_current_user)):
    try:
        return Response(desk.export_csv(client_id, q, days, source_id, view, user=user),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="articles.csv"'})
    except ValueError as exc:
        fail(exc)


@router.put("/api/settings")
def update_settings(data: SettingsInput, user=Depends(auth.require_admin)):
    values = data.model_dump(exclude={"clear_key", "api_key", "weread_api_key", "clear_weread_key"})
    if data.api_key:
        if not re.fullmatch(r"[A-Za-z0-9_-]{10,256}", data.api_key):
            raise HTTPException(400, "API Key 格式不正确，请检查是否包含空格或多余字符")
        values["api_key"] = data.api_key
    elif data.clear_key:
        values["api_key"] = ""
    if data.weread_api_key:
        if not re.fullmatch(r"wrk-[A-Za-z0-9_-]{8,508}", data.weread_api_key):
            raise HTTPException(400, "微信读书官方密钥格式不正确，应为 wrk- 开头")
        values["weread_api_key"] = data.weread_api_key
    elif data.clear_weread_key:
        values["weread_api_key"] = ""
    return desk.save_settings(values)


@router.post("/api/model-test")
async def model_test(user=Depends(auth.require_admin)):
    config = desk.settings()
    if not config["api_key"]:
        raise HTTPException(400, "请先保存 Eason 的服务密钥")
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
            response = await client.get("https://api.deepseek.com/models",
                headers={"Authorization": "Bearer " + config["api_key"]})
        if response.status_code != 200:
            raise HTTPException(400, "连接失败（HTTP " + str(response.status_code) + "），请核对密钥和网络")
        models = [item["id"] for item in response.json().get("data", [])]
        if config["model"] not in models:
            raise HTTPException(400, "连接成功，但当前账户未返回所选模型；请核对模型名称")
        return {"ok": True, "message": "密钥与模型连接通过；发送问题可验证实际对话"}
    except (httpx.HTTPError, ValueError, KeyError):
        raise HTTPException(400, "无法验证 Eason 的服务连接，请检查网络和密钥") from None


@router.post("/api/sync")
def sync(data: SyncInput, tasks: BackgroundTasks, user=Depends(auth.get_current_user)):
    try:
        run_id, ids = desk.prepare_sync(data.client_id, data.source_id, user=user)
    except ValueError as exc:
        fail(exc)
    tasks.add_task(desk.execute_sync, run_id, ids, user=user)
    return {"id": run_id, "source_count": len(ids)}


@router.post("/api/keywords")
def keywords(data: SyncInput, tasks: BackgroundTasks, user=Depends(auth.get_current_user)):
    try:
        ids = desk.prepare_keywords(data.client_id, user=user)
    except ValueError as exc:
        fail(exc)
    tasks.add_task(desk.execute_keywords, ids, data.client_id, user=user)
    return {"total": len(ids)}


@router.get("/api/weread/shelf")
def shelf(user=Depends(auth.require_admin)):
    from core.wx.model.weread import MpsWeread
    provider = MpsWeread()
    provider._load_weread_auth()
    books = provider._get_shelf_books()
    if books is None:
        raise HTTPException(400, "读取书架失败，请重新扫码或稍后重试")
    return {"items": [{"id": b["book_id"], "name": b["title"]} for b in books
                      if str(b["book_id"]).startswith("MP_WXS_")]}


@router.get("/api/weread/search")
async def search_sources(q: str = Query(min_length=1, max_length=100), user=Depends(auth.get_current_user)):
    try:
        return await desk.search_sources(q.strip())
    except ValueError as exc:
        fail(exc)


@router.get("/api/wechat/search")
def search_wechat_sources(q: str = Query(min_length=1, max_length=100), user=Depends(auth.get_current_user)):
    try:
        return desk.search_wechat_sources(q.strip())
    except ValueError as exc:
        fail(exc)


@router.post("/api/wechat/qr")
def wechat_qr(user=Depends(auth.require_admin)):
    from driver.wx import WX_API
    # Login driver already saves credentials; no notification callback is needed.
    WX_API.GetCode()
    return {"url": "/workbench/api/wechat/qr-image"}


@router.get("/api/wechat/status")
def wechat_status(user=Depends(auth.require_admin)):
    from driver.wx import WX_API
    from driver.token import get as get_wx_token
    running = WX_API.check_lock()
    return {"logged_in": bool(not running and WX_API.HasLogin() and get_wx_token("token")),
            "qr_ready": bool(running and WX_API.GetHasCode()), "running": running}


@router.post("/api/weread/qr")
def qr(user=Depends(auth.require_admin)):
    from apis.weread import get_weread_qrcode
    result = get_weread_qrcode(current_user={})
    if result["code"] != 0:
        raise HTTPException(400, "二维码获取失败，请稍后重试")
    return {"url": "/workbench/api/weread/qr-image"}


@router.get("/api/weread/status")
def qr_status(user=Depends(auth.require_admin)):
    from driver.weread_qr import WereadQRLogin
    value = WereadQRLogin().QrStatus()
    return {"logged_in": bool(value.get("login_status")), "message": str(value.get("msg", ""))[:200]}


@router.post("/api/chat")
async def chat(data: ChatInput, user=Depends(auth.get_current_user)):
    try:
        return await desk.chat(data.client_id, data.message, [v.model_dump() for v in data.history], user=user)
    except ValueError as exc:
        fail(exc)


@router.get("/login", include_in_schema=False)
def login_page(request: Request):
    auth.trusted_request(request)
    return FileResponse("public/workbench/login.html", headers={"Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'"})


@router.get("/healthz", include_in_schema=False)
def health():
    return {"status": "ok", "version": desk.DESK_VERSION}


@router.get("/api/weread/qr-image", include_in_schema=False)
def weread_qr_image(user=Depends(auth.require_admin)):
    path = Path("static/weread_qrcode.png")
    if not path.is_file():
        raise HTTPException(404, "二维码尚未生成")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-store"})


@router.get("/api/wechat/qr-image", include_in_schema=False)
def wechat_qr_image(user=Depends(auth.require_admin)):
    path = Path("static/wx_qrcode.png")
    if not path.is_file():
        raise HTTPException(404, "二维码尚未生成")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-store"})
