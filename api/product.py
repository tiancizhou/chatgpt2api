from __future__ import annotations

import asyncio
import base64
import time
from collections import defaultdict
from pathlib import Path

from fastapi import APIRouter, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from api.ai import ImageGenerationRequest
from api.support import extract_bearer_token, require_admin, require_product_user, resolve_image_base_url
from services.config import DATA_DIR
from services.log_service import LOG_TYPE_CALL, LoggedCall, log_service
from services.product_service import IMAGE_CREDIT_COST, ProductServiceError, product_service
from services.protocol import openai_v1_image_edit, openai_v1_image_generations

PRODUCT_IMAGES_DIR = DATA_DIR / "product_images"


def _save_b64_as_file(b64_data: str, job_id: str, base_url: str) -> str:
    PRODUCT_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    image_bytes = base64.b64decode(b64_data)
    filename = f"{job_id}.png"
    (PRODUCT_IMAGES_DIR / filename).write_bytes(image_bytes)
    return f"{base_url}/product_images/{filename}"


def _replace_b64_with_url(result: object, job_id: str, base_url: str) -> object:
    if not isinstance(result, dict) or "data" not in result:
        return result
    data_list = result.get("data")
    if not isinstance(data_list, list):
        return result
    new_data = []
    for index, item in enumerate(data_list):
        if isinstance(item, dict) and item.get("b64_json"):
            url = _save_b64_as_file(item["b64_json"], f"{job_id}_{index}" if index else job_id, base_url)
            new_data.append({"url": url, "revised_prompt": item.get("revised_prompt")})
        else:
            new_data.append(item)
    return {**result, "data": new_data}

GLOBAL_IMAGE_JOB_CONCURRENCY = 20
USER_IMAGE_JOB_CONCURRENCY = 1
image_job_semaphore = asyncio.Semaphore(GLOBAL_IMAGE_JOB_CONCURRENCY)
user_image_job_semaphores: defaultdict[str, asyncio.Semaphore] = defaultdict(
    lambda: asyncio.Semaphore(USER_IMAGE_JOB_CONCURRENCY),
)


class CredentialsRequest(BaseModel):
    username: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)


class RedeemCdkRequest(BaseModel):
    code: str = Field(..., min_length=1)


class CreateCdksRequest(BaseModel):
    credit_amount: int = Field(..., ge=1)
    count: int = Field(..., ge=1, le=500)


class AdjustCreditsRequest(BaseModel):
    amount: int = Field(...)


class ImageJobGenerationRequest(ImageGenerationRequest):
    client_request_id: str | None = None


def _raise_product_error(exc: ProductServiceError) -> None:
    raise HTTPException(status_code=exc.status_code, detail={"error": exc.message}) from exc


def _error_message_from_response(response: JSONResponse) -> str:
    try:
        content = response.body.decode("utf-8")
    except Exception:
        return "生成失败"
    return content or "生成失败"


def _duration_ms(started_at: float) -> int:
    return int((time.perf_counter() - started_at) * 1000)


def _format_seconds(duration_ms: int) -> str:
    return f"{duration_ms / 1000:.2f}s"


def _log_image_job_timing(
        identity: dict[str, object],
        job_id: str,
        kind: str,
        model: str,
        status: str,
        total_ms: int,
        queue_wait_ms: int,
        upstream_ms: int = 0,
        persist_ms: int = 0,
        error: str = "",
) -> None:
    duration_ms = total_ms + queue_wait_ms
    detail = {
        "key_id": identity.get("id"),
        "key_name": identity.get("name"),
        "user_id": identity.get("user_id"),
        "role": identity.get("role"),
        "endpoint": f"/api/user/images/{'edits' if kind == 'edit' else 'generations'}/jobs",
        "job_id": job_id,
        "kind": kind,
        "model": model,
        "status": status,
        "duration_ms": duration_ms,
        "running_ms": total_ms,
        "queue_wait_ms": queue_wait_ms,
        "upstream_ms": upstream_ms,
        "persist_ms": persist_ms,
    }
    if error:
        detail["error"] = error
    summary = (
        f"用户{'图生图' if kind == 'edit' else '文生图'}任务耗时："
        f"总 {_format_seconds(duration_ms)} / 排队 {_format_seconds(queue_wait_ms)} / "
        f"上游 {_format_seconds(upstream_ms)} / 保存 {_format_seconds(persist_ms)}"
    )
    log_service.add(LOG_TYPE_CALL, summary, detail)


async def _run_generation_job(job_id: str, identity: dict[str, object], payload: dict[str, object], queued_at: float) -> None:
    model = str(payload.get("model") or "")
    user_semaphore = user_image_job_semaphores[str(identity["user_id"])]
    async with user_semaphore:
        async with image_job_semaphore:
            queue_wait_ms = _duration_ms(queued_at)
            started = await run_in_threadpool(product_service.mark_image_job_running, job_id)
            if not started:
                return
            total_started_at = time.perf_counter()
            upstream_started_at = time.perf_counter()
            call = LoggedCall(identity, "/api/user/images/generations/jobs", model, "用户文生图")
            try:
                result = await call.run(openai_v1_image_generations.handle, payload)
                upstream_ms = _duration_ms(upstream_started_at)
                persist_started_at = time.perf_counter()
                if isinstance(result, JSONResponse) and result.status_code >= 400:
                    error = _error_message_from_response(result)
                    await run_in_threadpool(product_service.refund_image_job, job_id, error)
                    _log_image_job_timing(identity, job_id, "generation", model, "failed", _duration_ms(total_started_at), queue_wait_ms, upstream_ms, _duration_ms(persist_started_at), error)
                    return
                await run_in_threadpool(product_service.complete_image_job, job_id, result)
                _log_image_job_timing(identity, job_id, "generation", model, "success", _duration_ms(total_started_at), queue_wait_ms, upstream_ms, _duration_ms(persist_started_at))
            except Exception as exc:
                upstream_ms = _duration_ms(upstream_started_at)
                persist_started_at = time.perf_counter()
                await run_in_threadpool(product_service.refund_image_job, job_id, str(exc))
                _log_image_job_timing(identity, job_id, "generation", model, "failed", _duration_ms(total_started_at), queue_wait_ms, upstream_ms, _duration_ms(persist_started_at), str(exc))


async def _run_edit_job(job_id: str, identity: dict[str, object], payload: dict[str, object], queued_at: float) -> None:
    model = str(payload.get("model") or "")
    user_semaphore = user_image_job_semaphores[str(identity["user_id"])]
    async with user_semaphore:
        async with image_job_semaphore:
            queue_wait_ms = _duration_ms(queued_at)
            started = await run_in_threadpool(product_service.mark_image_job_running, job_id)
            if not started:
                return
            total_started_at = time.perf_counter()
            upstream_started_at = time.perf_counter()
            call = LoggedCall(identity, "/api/user/images/edits/jobs", model, "用户图生图")
            try:
                result = await call.run(openai_v1_image_edit.handle, payload)
                upstream_ms = _duration_ms(upstream_started_at)
                persist_started_at = time.perf_counter()
                if isinstance(result, JSONResponse) and result.status_code >= 400:
                    error = _error_message_from_response(result)
                    await run_in_threadpool(product_service.refund_image_job, job_id, error)
                    _log_image_job_timing(identity, job_id, "edit", model, "failed", _duration_ms(total_started_at), queue_wait_ms, upstream_ms, _duration_ms(persist_started_at), error)
                    return
                await run_in_threadpool(product_service.complete_image_job, job_id, result)
                _log_image_job_timing(identity, job_id, "edit", model, "success", _duration_ms(total_started_at), queue_wait_ms, upstream_ms, _duration_ms(persist_started_at))
            except Exception as exc:
                upstream_ms = _duration_ms(upstream_started_at)
                persist_started_at = time.perf_counter()
                await run_in_threadpool(product_service.refund_image_job, job_id, str(exc))
                _log_image_job_timing(identity, job_id, "edit", model, "failed", _duration_ms(total_started_at), queue_wait_ms, upstream_ms, _duration_ms(persist_started_at), str(exc))


def create_router() -> APIRouter:
    router = APIRouter()

    @router.post("/api/user/register")
    async def register_user(body: CredentialsRequest):
        try:
            return await run_in_threadpool(product_service.register, body.username, body.password)
        except ProductServiceError as exc:
            _raise_product_error(exc)

    @router.post("/api/user/login")
    async def login_user(body: CredentialsRequest):
        try:
            return await run_in_threadpool(product_service.login, body.username, body.password)
        except ProductServiceError as exc:
            _raise_product_error(exc)

    @router.post("/api/user/logout")
    async def logout_user(authorization: str | None = Header(default=None)):
        token = extract_bearer_token(authorization)
        await run_in_threadpool(product_service.revoke_session, token)
        return {"ok": True}

    @router.get("/api/user/me")
    async def get_user_me(authorization: str | None = Header(default=None)):
        identity = require_product_user(authorization)
        try:
            user = await run_in_threadpool(product_service.get_user, str(identity["user_id"]))
        except ProductServiceError as exc:
            _raise_product_error(exc)
        return {"user": user, "credit_balance": user["credit_balance"]}

    @router.get("/api/user/balance")
    async def get_user_balance(authorization: str | None = Header(default=None)):
        identity = require_product_user(authorization)
        try:
            balance = await run_in_threadpool(product_service.get_balance, str(identity["user_id"]))
        except ProductServiceError as exc:
            _raise_product_error(exc)
        return {"credit_balance": balance}

    @router.post("/api/user/cdks/redeem")
    async def redeem_cdk(body: RedeemCdkRequest, authorization: str | None = Header(default=None)):
        identity = require_product_user(authorization)
        try:
            result = await run_in_threadpool(product_service.redeem_cdk, str(identity["user_id"]), body.code)
        except ProductServiceError as exc:
            _raise_product_error(exc)
        return result

    @router.post("/api/user/images/generations/jobs")
    async def create_user_image_generation_job(
            body: ImageJobGenerationRequest,
            request: Request,
            authorization: str | None = Header(default=None),
    ):
        identity = require_product_user(authorization)
        if body.stream:
            raise HTTPException(status_code=400, detail={"error": "用户端暂不支持流式生图"})
        if body.n != 1:
            raise HTTPException(status_code=400, detail={"error": "用户端每次请求只能生成 1 张图"})
        try:
            job = await run_in_threadpool(
                product_service.start_image_job,
                str(identity["user_id"]),
                body.prompt,
                body.model,
                IMAGE_CREDIT_COST,
                "generation",
                body.client_request_id,
            )
        except ProductServiceError as exc:
            _raise_product_error(exc)

        payload = body.model_dump(mode="python", exclude={"client_request_id"})
        payload["n"] = 1
        payload["stream"] = False
        payload["base_url"] = resolve_image_base_url(request)
        asyncio.create_task(_run_generation_job(str(job["id"]), identity, payload, time.perf_counter()))
        return {"job_id": job["id"], "status": "running", "credit_cost": IMAGE_CREDIT_COST}

    @router.get("/api/user/images/jobs/{job_id}")
    async def get_user_image_job(job_id: str, authorization: str | None = Header(default=None)):
        identity = require_product_user(authorization)
        try:
            return await run_in_threadpool(product_service.get_image_job, str(identity["user_id"]), job_id)
        except ProductServiceError as exc:
            _raise_product_error(exc)

    @router.get("/api/user/images/history")
    async def list_user_image_history(authorization: str | None = Header(default=None), limit: int = 100):
        identity = require_product_user(authorization)
        return {"items": await run_in_threadpool(product_service.list_user_image_history, str(identity["user_id"]), limit)}

    @router.delete("/api/user/images/history/{job_id}")
    async def delete_user_image_history_item(job_id: str, authorization: str | None = Header(default=None)):
        identity = require_product_user(authorization)
        try:
            await run_in_threadpool(product_service.delete_user_image_history_item, str(identity["user_id"]), job_id)
        except ProductServiceError as exc:
            _raise_product_error(exc)
        return {"ok": True}

    @router.delete("/api/user/images/history")
    async def clear_user_image_history(authorization: str | None = Header(default=None)):
        identity = require_product_user(authorization)
        await run_in_threadpool(product_service.clear_user_image_history, str(identity["user_id"]))
        return {"ok": True}

    @router.post("/api/user/images/generations")
    async def generate_user_image(
            body: ImageGenerationRequest,
            request: Request,
            authorization: str | None = Header(default=None),
    ):
        identity = require_product_user(authorization)
        if body.stream:
            raise HTTPException(status_code=400, detail={"error": "用户端暂不支持流式生图"})
        if body.n != 1:
            raise HTTPException(status_code=400, detail={"error": "用户端每次请求只能生成 1 张图"})
        try:
            job = await run_in_threadpool(
                product_service.start_image_job,
                str(identity["user_id"]),
                body.prompt,
                body.model,
                IMAGE_CREDIT_COST,
            )
        except ProductServiceError as exc:
            _raise_product_error(exc)

        payload = body.model_dump(mode="python")
        payload["n"] = 1
        payload["stream"] = False
        payload["base_url"] = resolve_image_base_url(request)
        call = LoggedCall(identity, "/api/user/images/generations", body.model, "用户文生图")
        try:
            result = await call.run(openai_v1_image_generations.handle, payload)
            if isinstance(result, JSONResponse) and result.status_code >= 400:
                await run_in_threadpool(product_service.refund_image_job, str(job["id"]), _error_message_from_response(result))
                return result
            await run_in_threadpool(product_service.complete_image_job, str(job["id"]), result)
            url_result = await run_in_threadpool(_replace_b64_with_url, result, str(job["id"]), resolve_image_base_url(request))
            return url_result
        except asyncio.CancelledError:
            await run_in_threadpool(product_service.fail_image_job_without_refund, str(job["id"]), "请求已取消")
            raise
        except Exception as exc:
            await run_in_threadpool(product_service.refund_image_job, str(job["id"]), str(exc))
            raise

    @router.post("/api/user/images/edits/jobs")
    async def create_user_image_edit_job(
            request: Request,
            authorization: str | None = Header(default=None),
            image: list[UploadFile] | None = File(default=None),
            image_list: list[UploadFile] | None = File(default=None, alias="image[]"),
            prompt: str = Form(...),
            model: str = Form(default="gpt-image-2"),
            n: int = Form(default=1),
            size: str | None = Form(default=None),
            response_format: str = Form(default="b64_json"),
            stream: bool | None = Form(default=None),
            client_request_id: str | None = Form(default=None),
    ):
        identity = require_product_user(authorization)
        if stream:
            raise HTTPException(status_code=400, detail={"error": "用户端暂不支持流式生图"})
        if n != 1:
            raise HTTPException(status_code=400, detail={"error": "用户端每次请求只能生成 1 张图"})
        uploads = [*(image or []), *(image_list or [])]
        if not uploads:
            raise HTTPException(status_code=400, detail={"error": "image file is required"})
        images: list[tuple[bytes, str, str]] = []
        for upload in uploads:
            image_data = await upload.read()
            if not image_data:
                raise HTTPException(status_code=400, detail={"error": "image file is empty"})
            images.append((image_data, upload.filename or "image.png", upload.content_type or "image/png"))
        try:
            job = await run_in_threadpool(
                product_service.start_image_job,
                str(identity["user_id"]),
                prompt,
                model,
                IMAGE_CREDIT_COST,
                "edit",
                client_request_id,
            )
        except ProductServiceError as exc:
            _raise_product_error(exc)

        payload = {
            "prompt": prompt,
            "images": images,
            "model": model,
            "n": 1,
            "size": size,
            "response_format": response_format,
            "stream": False,
            "base_url": resolve_image_base_url(request),
        }
        asyncio.create_task(_run_edit_job(str(job["id"]), identity, payload, time.perf_counter()))
        return {"job_id": job["id"], "status": "running", "credit_cost": IMAGE_CREDIT_COST}

    @router.post("/api/user/images/edits")
    async def edit_user_image(
            request: Request,
            authorization: str | None = Header(default=None),
            image: list[UploadFile] | None = File(default=None),
            image_list: list[UploadFile] | None = File(default=None, alias="image[]"),
            prompt: str = Form(...),
            model: str = Form(default="gpt-image-2"),
            n: int = Form(default=1),
            size: str | None = Form(default=None),
            response_format: str = Form(default="b64_json"),
            stream: bool | None = Form(default=None),
    ):
        identity = require_product_user(authorization)
        if stream:
            raise HTTPException(status_code=400, detail={"error": "用户端暂不支持流式生图"})
        if n != 1:
            raise HTTPException(status_code=400, detail={"error": "用户端每次请求只能生成 1 张图"})
        uploads = [*(image or []), *(image_list or [])]
        if not uploads:
            raise HTTPException(status_code=400, detail={"error": "image file is required"})
        images: list[tuple[bytes, str, str]] = []
        for upload in uploads:
            image_data = await upload.read()
            if not image_data:
                raise HTTPException(status_code=400, detail={"error": "image file is empty"})
            images.append((image_data, upload.filename or "image.png", upload.content_type or "image/png"))
        try:
            job = await run_in_threadpool(
                product_service.start_image_job,
                str(identity["user_id"]),
                prompt,
                model,
                IMAGE_CREDIT_COST,
            )
        except ProductServiceError as exc:
            _raise_product_error(exc)

        payload = {
            "prompt": prompt,
            "images": images,
            "model": model,
            "n": 1,
            "size": size,
            "response_format": response_format,
            "stream": False,
            "base_url": resolve_image_base_url(request),
        }
        call = LoggedCall(identity, "/api/user/images/edits", model, "用户图生图")
        try:
            result = await call.run(openai_v1_image_edit.handle, payload)
            if isinstance(result, JSONResponse) and result.status_code >= 400:
                await run_in_threadpool(product_service.refund_image_job, str(job["id"]), _error_message_from_response(result))
                return result
            await run_in_threadpool(product_service.complete_image_job, str(job["id"]), result)
            url_result = await run_in_threadpool(_replace_b64_with_url, result, str(job["id"]), resolve_image_base_url(request))
            return url_result
        except asyncio.CancelledError:
            await run_in_threadpool(product_service.fail_image_job_without_refund, str(job["id"]), "请求已取消")
            raise
        except Exception as exc:
            await run_in_threadpool(product_service.refund_image_job, str(job["id"]), str(exc))
            raise

    @router.get("/api/admin/product/users")
    async def list_product_users(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        items = await run_in_threadpool(product_service.list_users)
        return {"items": items}

    @router.post("/api/admin/product/users/{user_id}/credits")
    async def adjust_product_user_credits(
            user_id: str,
            body: AdjustCreditsRequest,
            authorization: str | None = Header(default=None),
    ):
        require_admin(authorization)
        try:
            user = await run_in_threadpool(product_service.adjust_user_credits, user_id, body.amount)
        except ProductServiceError as exc:
            _raise_product_error(exc)
        return {"user": user}

    @router.post("/api/admin/cdks")
    async def create_cdks(body: CreateCdksRequest, authorization: str | None = Header(default=None)):
        identity = require_admin(authorization)
        created_by = str(identity.get("name") or identity.get("id") or "admin")
        try:
            items = await run_in_threadpool(product_service.create_cdks, body.count, body.credit_amount, created_by)
        except ProductServiceError as exc:
            _raise_product_error(exc)
        return {"items": items}

    @router.get("/api/admin/cdks")
    async def list_cdks(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        items = await run_in_threadpool(product_service.list_cdks)
        return {"items": items}

    @router.post("/api/admin/cdks/{cdk_id}/disable")
    async def disable_cdk(cdk_id: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            return await run_in_threadpool(product_service.disable_cdk, cdk_id)
        except ProductServiceError as exc:
            _raise_product_error(exc)

    return router
