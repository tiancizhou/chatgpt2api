from __future__ import annotations

from contextlib import asynccontextmanager
from threading import Event

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from api import accounts, ai, product, register, system
from api.support import resolve_web_asset, start_limited_account_watcher
from services.config import DATA_DIR, config


STATIC_CACHE_CONTROL = "public, max-age=31536000, immutable"
IMAGE_CACHE_CONTROL = "public, max-age=2592000"
HTML_CACHE_CONTROL = "no-cache"


class CachedStaticFiles(StaticFiles):
    def __init__(self, *args, cache_control: str, **kwargs):
        super().__init__(*args, **kwargs)
        self.cache_control = cache_control

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = self.cache_control
        return response


def _web_cache_control(path: str) -> str:
    normalized = path.strip("/")
    if normalized.startswith("_next/static/"):
        return STATIC_CACHE_CONTROL
    if normalized.endswith((".js", ".css", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".woff", ".woff2")):
        return STATIC_CACHE_CONTROL
    return HTML_CACHE_CONTROL


def create_app() -> FastAPI:
    app_version = config.app_version

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        stop_event = Event()
        thread = start_limited_account_watcher(stop_event)
        config.cleanup_old_images()
        try:
            yield
        finally:
            stop_event.set()
            thread.join(timeout=1)

    app = FastAPI(title="chatgpt2api", version=app_version, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(ai.create_router())
    app.include_router(product.create_router())
    app.include_router(accounts.create_router())
    app.include_router(register.create_router())
    app.include_router(system.create_router(app_version))
    if config.images_dir.exists():
        app.mount("/images", CachedStaticFiles(directory=str(config.images_dir), cache_control=IMAGE_CACHE_CONTROL), name="images")
    product_images_dir = DATA_DIR / "product_images"
    product_images_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/product_images", CachedStaticFiles(directory=str(product_images_dir), cache_control=IMAGE_CACHE_CONTROL), name="product_images")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_web(full_path: str):
        asset = resolve_web_asset(full_path)
        if asset is not None:
            return FileResponse(asset, headers={"Cache-Control": _web_cache_control(full_path)})
        if full_path.strip("/").startswith("_next/"):
            raise HTTPException(status_code=404, detail="Not Found")
        fallback = resolve_web_asset("")
        if fallback is None:
            raise HTTPException(status_code=404, detail="Not Found")
        return FileResponse(fallback, headers={"Cache-Control": HTML_CACHE_CONTROL})

    return app
