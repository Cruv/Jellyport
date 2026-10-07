from __future__ import annotations

import hashlib
import asyncio
import contextlib
import hmac
import os
import re
import secrets
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from .bot import BotManager
from .demo import DemoServers
from .media import MediaError
from .service import Service, ServiceError
from .store import DEFAULT_SETTINGS, Store

load_dotenv()
STATIC = Path(__file__).parent / "static"
SECRETS = ("emby_api_key", "jellyfin_api_key", "discord_bot_token")


class Login(BaseModel):
    password: str = Field(max_length=512)


class AccountRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=1, max_length=64)
    discord_user_id: str | None = Field(default=None, pattern=r"^[0-9]{5,22}$")


class RecoveryRequest(AccountRequest):
    target_user_id: str = Field(min_length=1, max_length=128)


class MigrationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_user_ids: list[str] = Field(min_length=1, max_length=100)
    discord_recipients: dict[str, str] = Field(default_factory=dict)


def validate_settings(settings: dict):
    if set(settings) - set(DEFAULT_SETTINGS):
        raise ServiceError("Unknown setting supplied.")
    for key, default in DEFAULT_SETTINGS.items():
        value = settings.get(key, default)
        if isinstance(default, bool) and not isinstance(value, bool):
            raise ServiceError(f"{key} must be a boolean.")
        if isinstance(default, str) and (not isinstance(value, str) or len(value) > 4096):
            raise ServiceError(f"{key} must be a string of at most 4096 characters.")
        if isinstance(value, str) and any(ord(c) < 32 for c in value):
            raise ServiceError("Settings cannot contain control characters.")
    for key in ("emby_url", "jellyfin_url", "jellyfin_public_url"):
        value = settings.get(key, "")
        if value:
            parsed = urlsplit(value)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise ServiceError("Server URLs must use http:// or https:// without embedded credentials, query strings or fragments.")
    for key in ("discord_guild_id", "discord_admin_role_id", "discord_member_role_id", "discord_application_id", "discord_subscription_channel_id", "discord_subscription_bot_id"):
        if settings.get(key) and not re.fullmatch(r"[0-9]{5,22}", settings[key]):
            raise ServiceError(f"{key} must be a Discord numeric ID.")
    mappings = settings.get("path_mappings", [])
    if not isinstance(mappings, list) or len(mappings) > 20:
        raise ServiceError("Provide at most 20 path mappings.")
    for mapping in mappings:
        if not isinstance(mapping, dict) or set(mapping) != {"source", "target"} or not all(isinstance(v, str) and v and len(v) < 1024 and not any(ord(c) < 32 for c in v) for v in mapping.values()):
            raise ServiceError("Each path mapping needs nonempty source and target prefixes.")
    if settings.get("discord_enabled") and (not settings.get("discord_bot_token") or not settings.get("discord_guild_id")):
        raise ServiceError("To enable Discord, supply the bot token and server ID.")
    if settings.get("discord_message_events") and (not settings.get("discord_subscription_channel_id") or not settings.get("discord_subscription_bot_id")):
        raise ServiceError("MEE6 message events require the trusted bot ID and subscription channel ID.")
    if settings.get("discord_role_events") and not settings.get("discord_member_role_id"):
        raise ServiceError("Membership role events require an active subscriber role ID.")
    if (settings.get("auto_provision") or settings.get("auto_disable")) and (not settings.get("discord_enabled") or not (settings.get("discord_message_events") or settings.get("discord_role_events"))):
        raise ServiceError("Automation requires a connected Discord configuration and a message or role event source.")


def create_app(admin_password=None, data_dir=None, demo=None, client_factory=None):
    demo = os.getenv("JELLYPORT_DEMO", "false").lower() == "true" if demo is None else demo
    password = admin_password if admin_password is not None else os.getenv("JELLYPORT_ADMIN_PASSWORD", "demo-jellyport" if demo else "")
    directory = data_dir or os.getenv("JELLYPORT_DATA_DIR", "./data")
    secure_cookie = os.getenv("JELLYPORT_SECURE_COOKIE", "false").lower() == "true"
    sessions: dict[str, dict] = {}
    login_attempts = defaultdict(list)
    salt = secrets.token_bytes(16)
    password_hash = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1)

    @asynccontextmanager
    async def lifespan(app):
        if len(password) < 12 or password.startswith("replace-with"):
            raise RuntimeError("Set JELLYPORT_ADMIN_PASSWORD to a strong password of at least 12 characters before starting Jellyport.")
        store = Store(directory)
        if demo:
            servers = DemoServers()
            settings = DEFAULT_SETTINGS | {"emby_url": "http://demo-emby", "emby_api_key": "demo", "jellyfin_url": "http://demo-jellyfin", "jellyfin_api_key": "demo", "jellyfin_public_url": "https://jellyfin.example.com", "template_user_id": "template"}
            store.save_settings(settings)
            factory = servers.factory
        else:
            factory = client_factory
        service = Service(store, demo=demo, **({"client_factory": factory} if factory else {}))
        bot = BotManager(service)
        service.bot = bot
        app.state.store, app.state.service, app.state.bot = store, service, bot
        if not demo:
            await bot.restart(store.settings())
        async def maintenance():
            while True:
                await asyncio.sleep(300)
                store.purge_expired()
                if not demo:
                    with contextlib.suppress(ServiceError, MediaError):
                        await service.reconcile_memberships()
        store.purge_expired()
        upkeep = asyncio.create_task(maintenance())
        try:
            yield
        finally:
            upkeep.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await upkeep
            await bot.stop()
            await service.stop()
            store.close()

    app = FastAPI(title="Jellyport", version="0.1.0", lifespan=lifespan, docs_url=None, redoc_url=None)

    @app.middleware("http")
    async def security_headers(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
        return response

    @app.exception_handler(ServiceError)
    async def service_error(request, error):
        return JSONResponse({"detail": str(error)}, status_code=400)

    @app.exception_handler(MediaError)
    async def media_error(request, error):
        return JSONResponse({"detail": str(error)}, status_code=502)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        # Never echo invalid request inputs, which may contain secrets.
        return JSONResponse({"detail": "Invalid request. Check the selected users and field values."}, status_code=422)

    def session(request):
        sid = request.cookies.get("jellyport_session", "")
        value = sessions.get(sid)
        if value and value["expires"] <= time.time():
            sessions.pop(sid, None)
            value = None
        return sid, value

    def csrf(request: Request):
        _, value = session(request)
        token = request.headers.get("X-CSRF-Token", "")
        if not value or not hmac.compare_digest(value["csrf_token"], token):
            raise HTTPException(403, "Session expired or CSRF token missing. Reload the page.")
        return value

    def authenticated(request: Request):
        _, value = session(request)
        if not value or not value["authenticated"]:
            raise HTTPException(401, "Sign in to Jellyport.")
        if request.method not in {"GET", "HEAD"}:
            csrf(request)
        return value

    def new_session(response, logged_in=False):
        # Bound memory and prune anonymous sessions periodically.
        expired = [k for k, v in sessions.items() if v["expires"] <= time.time()]
        for key in expired:
            sessions.pop(key, None)
        if len(sessions) >= 10000:
            raise HTTPException(503, "Too many active sessions. Try again later.")
        sid = secrets.token_urlsafe(32)
        value = {"authenticated": logged_in, "csrf_token": secrets.token_urlsafe(32), "expires": time.time() + (28800 if logged_in else 1800)}
        sessions[sid] = value
        response.set_cookie("jellyport_session", sid, httponly=True, secure=secure_cookie, samesite="strict", max_age=28800 if logged_in else 1800)
        return {"authenticated": logged_in, "csrf_token": value["csrf_token"], "demo": demo}

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/api/session")
    async def get_session(request: Request, response: Response):
        _, value = session(request)
        if not value:
            return new_session(response)
        return {"authenticated": value["authenticated"], "csrf_token": value["csrf_token"], "demo": demo}

    @app.post("/api/login")
    async def login(body: Login, request: Request, response: Response, _=Depends(csrf)):
        ip = request.client.host if request.client else "unknown"
        attempts = [t for t in login_attempts[ip] if t > time.time() - 600]
        if len(attempts) >= 10:
            raise HTTPException(429, "Too many sign-in attempts. Wait ten minutes.")
        attempts.append(time.time())
        login_attempts[ip] = attempts
        supplied = hashlib.scrypt(body.password.encode(), salt=salt, n=16384, r=8, p=1)
        if not hmac.compare_digest(password_hash, supplied):
            raise HTTPException(401, "Incorrect admin password.")
        login_attempts.pop(ip, None)
        sid, _ = session(request)
        sessions.pop(sid, None)
        return new_session(response, True)

    @app.post("/api/logout")
    async def logout(request: Request, response: Response, _=Depends(authenticated)):
        sid, _ = session(request)
        sessions.pop(sid, None)
        return new_session(response)

    @app.get("/api/settings", dependencies=[Depends(authenticated)])
    async def settings_get():
        settings = app.state.store.settings()
        public = {key: value for key, value in settings.items() if key not in SECRETS}
        public.update({f"{key}_set": bool(settings[key]) for key in SECRETS})
        public["bot_invite_url"] = "https://discord.com/oauth2/authorize?" + urlencode({"client_id": settings["discord_application_id"], "scope": "bot applications.commands", "permissions": "68608", "guild_id": settings["discord_guild_id"], "disable_guild_select": "true"}) if settings["discord_application_id"] else ""
        return public

    @app.put("/api/settings", dependencies=[Depends(authenticated)])
    async def settings_put(request: Request):
        if demo:
            raise ServiceError("Demo settings are read-only. Run without JELLYPORT_DEMO to connect your servers.")
        if int(request.headers.get("content-length", "0")) > 65536:
            raise HTTPException(413, "Settings request too large.")
        incoming = await request.json()
        if not isinstance(incoming, dict):
            raise ServiceError("Settings must be an object.")
        stored = app.state.store.settings()
        for key in SECRETS:
            if key in incoming and not incoming[key]:
                incoming.pop(key)  # Blank secret fields preserve saved values.
        merged = stored | incoming
        validate_settings(merged)
        for key in ("emby_url", "jellyfin_url", "jellyfin_public_url"):
            merged[key] = merged[key].rstrip("/")
        app.state.store.save_settings(merged)
        await app.state.bot.restart(merged)
        return await settings_get()

    @app.get("/api/users", dependencies=[Depends(authenticated)])
    async def users():
        return await app.state.service.users()

    @app.post("/api/connections/test", dependencies=[Depends(authenticated)])
    async def connections():
        return await app.state.service.connections()

    @app.get("/api/overview", dependencies=[Depends(authenticated)])
    async def overview():
        connections = await app.state.service.connections()
        counts = {"emby_users": 0, "jellyfin_users": 0, "jobs": len(app.state.store.jobs())}
        try:
            users = await app.state.service.users()
            counts.update(emby_users=len(users["emby"]), jellyfin_users=len(users["jellyfin"]))
        except (ServiceError, MediaError):
            pass
        return {"counts": counts, "connections": connections, "recent_jobs": app.state.store.jobs()[:6], "pending_subscriptions": sum(e["status"] == "pending" for e in app.state.store.subscriptions()), "demo": demo}

    @app.post("/api/migrations/preview", dependencies=[Depends(authenticated)])
    async def preview(body: MigrationRequest):
        if len(set(body.source_user_ids)) != len(body.source_user_ids):
            raise ServiceError("Select distinct Emby users.")
        return await app.state.service.preview(body.source_user_ids)

    @app.post("/api/migrations", dependencies=[Depends(authenticated)], status_code=202)
    async def migrate(body: MigrationRequest):
        if not all(re.fullmatch(r"[0-9]{5,22}", value) for value in body.discord_recipients.values()):
            raise ServiceError("Discord recipients must be numeric user IDs.")
        return await app.state.service.migrate_users(body.source_user_ids, body.discord_recipients)

    @app.post("/api/accounts", dependencies=[Depends(authenticated)], status_code=202)
    async def create(body: AccountRequest):
        return await app.state.service.create_account(body.username, body.discord_user_id)

    @app.get("/api/accounts/recovery", dependencies=[Depends(authenticated)])
    async def recovery_info(username: str):
        return await app.state.service.recovery_info(username)

    @app.post("/api/accounts/recover", dependencies=[Depends(authenticated)], status_code=202)
    async def recover(body: RecoveryRequest):
        return await app.state.service.recover_account(body.username, body.target_user_id, body.discord_user_id)

    @app.get("/api/jobs", dependencies=[Depends(authenticated)])
    async def jobs():
        return {"jobs": app.state.store.jobs()}

    @app.get("/api/jobs/{job_id}", dependencies=[Depends(authenticated)])
    async def job(job_id: str):
        return app.state.service.get_job(job_id)

    @app.post("/api/jobs/{job_id}/credentials", dependencies=[Depends(authenticated)])
    async def credentials(job_id: str):
        job = app.state.service.get_job(job_id)
        if job["status"] in {"queued", "running"}:
            raise ServiceError("Wait for the job to finish before revealing its credentials.")
        return {"credentials": app.state.store.take_credentials(job_id)}

    @app.get("/api/subscriptions", dependencies=[Depends(authenticated)])
    async def subscriptions():
        return {"events": app.state.store.subscriptions()}

    @app.post("/api/subscriptions/{event_id}/apply", dependencies=[Depends(authenticated)])
    async def apply_event(event_id: str):
        return await app.state.service.apply_subscription(event_id)

    @app.post("/api/subscriptions/{event_id}/ignore", dependencies=[Depends(authenticated)])
    async def ignore_event(event_id: str):
        return app.state.service.ignore_subscription(event_id)

    @app.get("/", include_in_schema=False)
    async def index():
        return FileResponse(STATIC / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC, check_dir=False), name="static")
    return app


app = create_app()
