from __future__ import annotations

from datetime import datetime, timedelta, timezone
import base64
import hashlib
import hmac
import json
import re
import secrets
import string
from typing import Any
from uuid import uuid4

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    and_,
    create_engine,
    delete,
    insert,
    select,
    update,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.pool import StaticPool

from services.config import DATA_DIR

USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_.@-]{3,32}$")
PASSWORD_ITERATIONS = 210_000
SESSION_TTL_DAYS = 30
IMAGE_CREDIT_COST = 2


class ProductServiceError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


metadata = MetaData()

product_users = Table(
    "product_users",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("username", String(64), unique=True, nullable=False, index=True),
    Column("password_hash", Text, nullable=False),
    Column("credit_balance", Integer, nullable=False, default=0),
    Column("enabled", Boolean, nullable=False, default=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    Column("last_login_at", DateTime(timezone=True), nullable=True),
)

product_sessions = Table(
    "product_sessions",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("user_id", String(36), ForeignKey("product_users.id"), nullable=False, index=True),
    Column("token_hash", String(64), unique=True, nullable=False, index=True),
    Column("expires_at", DateTime(timezone=True), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("last_used_at", DateTime(timezone=True), nullable=True),
    Column("revoked_at", DateTime(timezone=True), nullable=True),
)

cdks = Table(
    "cdks",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("code_hash", String(64), unique=True, nullable=False, index=True),
    Column("code_preview", String(32), nullable=False),
    Column("credit_amount", Integer, nullable=False),
    Column("status", String(16), nullable=False, default="unused"),
    Column("created_by", String(128), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("redeemed_by_user_id", String(36), ForeignKey("product_users.id"), nullable=True),
    Column("redeemed_at", DateTime(timezone=True), nullable=True),
)

credit_ledger = Table(
    "credit_ledger",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("user_id", String(36), ForeignKey("product_users.id"), nullable=False, index=True),
    Column("delta", Integer, nullable=False),
    Column("balance_after", Integer, nullable=False),
    Column("type", String(32), nullable=False),
    Column("reference_id", String(64), nullable=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

image_generation_jobs = Table(
    "image_generation_jobs",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("user_id", String(36), ForeignKey("product_users.id"), nullable=False, index=True),
    Column("status", String(16), nullable=False),
    Column("kind", String(16), nullable=False, default="generation"),
    Column("client_request_id", String(96), nullable=True, index=True),
    Column("credit_cost", Integer, nullable=False),
    Column("prompt", Text, nullable=False),
    Column("model", String(64), nullable=False),
    Column("result_urls", Text, nullable=False, default="[]"),
    Column("result_payload", Text, nullable=False, default=""),
    Column("error_message", Text, nullable=False, default=""),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    Column("completed_at", DateTime(timezone=True), nullable=True),
)


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _hash_value(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _normalize_username(username: str) -> str:
    return str(username or "").strip().lower()


def _hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        PASSWORD_ITERATIONS,
        base64.urlsafe_b64encode(salt).decode("ascii"),
        base64.urlsafe_b64encode(digest).decode("ascii"),
    )


def _verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, iterations, salt_value, digest_value = stored_hash.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        salt = base64.urlsafe_b64decode(salt_value.encode("ascii"))
        expected = base64.urlsafe_b64decode(digest_value.encode("ascii"))
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations))
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def _public_user(row: Any) -> dict[str, object]:
    return {
        "id": row.id,
        "username": row.username,
        "credit_balance": int(row.credit_balance or 0),
        "enabled": bool(row.enabled),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "last_login_at": row.last_login_at.isoformat() if row.last_login_at else None,
    }


def _collect_urls(value: object) -> list[str]:
    urls: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "url" and isinstance(item, str):
                urls.append(item)
            elif key == "urls" and isinstance(item, list):
                urls.extend(str(url) for url in item if isinstance(url, str))
            else:
                urls.extend(_collect_urls(item))
    elif isinstance(value, list):
        for item in value:
            urls.extend(_collect_urls(item))
    return list(dict.fromkeys(urls))


def _serialize_json(value: object) -> str:
    if hasattr(value, "body"):
        try:
            return value.body.decode("utf-8")
        except Exception:
            return ""
    try:
        return json.dumps(value, ensure_ascii=False)
    except TypeError:
        return ""


def _deserialize_json(value: str | None) -> object | None:
    if not value:
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None


def _public_image_job(row: Any, include_result: bool = True) -> dict[str, object]:
    return {
        "id": row.id,
        "status": row.status,
        "kind": getattr(row, "kind", "generation") or "generation",
        "client_request_id": getattr(row, "client_request_id", None),
        "credit_cost": int(row.credit_cost or 0),
        "prompt": row.prompt,
        "model": row.model,
        "result": _deserialize_json(getattr(row, "result_payload", "")) if include_result else None,
        "error_message": row.error_message or "",
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if getattr(row, "updated_at", None) else None,
        "completed_at": row.completed_at.isoformat() if row.completed_at else None,
    }


class ProductService:
    def __init__(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.engine = create_engine(
            f"sqlite:///{DATA_DIR / 'product.sqlite3'}",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
            future=True,
        )
        metadata.create_all(self.engine)
        self._migrate_image_jobs_table()

    def _migrate_image_jobs_table(self) -> None:
        required_columns = {
            "kind": "VARCHAR(16) NOT NULL DEFAULT 'generation'",
            "client_request_id": "VARCHAR(96)",
            "result_payload": "TEXT NOT NULL DEFAULT ''",
            "updated_at": "DATETIME",
        }
        with self.engine.begin() as connection:
            existing_columns = {
                row[1]
                for row in connection.exec_driver_sql("PRAGMA table_info(image_generation_jobs)").fetchall()
            }
            for column_name, column_definition in required_columns.items():
                if column_name not in existing_columns:
                    connection.exec_driver_sql(
                        f"ALTER TABLE image_generation_jobs ADD COLUMN {column_name} {column_definition}"
                    )
            connection.exec_driver_sql(
                "UPDATE image_generation_jobs SET updated_at = COALESCE(updated_at, completed_at, created_at) WHERE updated_at IS NULL"
            )

    def register(self, username: str, password: str) -> dict[str, object]:
        normalized_username = _normalize_username(username)
        self._validate_credentials(normalized_username, password)
        user_id = str(uuid4())
        now = _now()
        try:
            with self.engine.begin() as connection:
                connection.execute(insert(product_users).values(
                    id=user_id,
                    username=normalized_username,
                    password_hash=_hash_password(password),
                    credit_balance=0,
                    enabled=True,
                    created_at=now,
                    updated_at=now,
                ))
                user = connection.execute(select(product_users).where(product_users.c.id == user_id)).one()
        except IntegrityError as exc:
            raise ProductServiceError("用户名已存在", 409) from exc
        return self._issue_session(user)

    def login(self, username: str, password: str) -> dict[str, object]:
        normalized_username = _normalize_username(username)
        with self.engine.begin() as connection:
            user = connection.execute(
                select(product_users).where(product_users.c.username == normalized_username)
            ).first()
            if user is None or not bool(user.enabled) or not _verify_password(password, user.password_hash):
                raise ProductServiceError("用户名或密码错误", 401)
            now = _now()
            connection.execute(
                update(product_users)
                .where(product_users.c.id == user.id)
                .values(last_login_at=now, updated_at=now)
            )
            user = connection.execute(select(product_users).where(product_users.c.id == user.id)).one()
        return self._issue_session(user)

    def authenticate_session(self, token: str) -> dict[str, object] | None:
        token_hash = _hash_value(str(token or "").strip())
        if not token_hash:
            return None
        now = _now()
        with self.engine.begin() as connection:
            session = connection.execute(
                select(product_sessions, product_users)
                .join(product_users, product_sessions.c.user_id == product_users.c.id)
                .where(product_sessions.c.token_hash == token_hash)
            ).first()
            if session is None:
                return None
            session_row = session._mapping
            if session_row[product_sessions.c.revoked_at] is not None:
                return None
            if session_row[product_sessions.c.expires_at] <= now:
                return None
            if not bool(session_row[product_users.c.enabled]):
                return None
            connection.execute(
                update(product_sessions)
                .where(product_sessions.c.id == session_row[product_sessions.c.id])
                .values(last_used_at=now)
            )
            return {
                "id": session_row[product_users.c.id],
                "user_id": session_row[product_users.c.id],
                "name": session_row[product_users.c.username],
                "username": session_row[product_users.c.username],
                "role": "customer",
                "auth_type": "product_session",
                "credit_balance": int(session_row[product_users.c.credit_balance] or 0),
            }

    def revoke_session(self, token: str) -> None:
        token_hash = _hash_value(str(token or "").strip())
        with self.engine.begin() as connection:
            connection.execute(
                update(product_sessions)
                .where(product_sessions.c.token_hash == token_hash, product_sessions.c.revoked_at.is_(None))
                .values(revoked_at=_now())
            )

    def get_user(self, user_id: str) -> dict[str, object]:
        with self.engine.begin() as connection:
            user = connection.execute(select(product_users).where(product_users.c.id == user_id)).first()
            if user is None:
                raise ProductServiceError("用户不存在", 404)
            return _public_user(user)

    def get_balance(self, user_id: str) -> int:
        with self.engine.begin() as connection:
            balance = connection.execute(
                select(product_users.c.credit_balance).where(product_users.c.id == user_id)
            ).scalar_one_or_none()
            if balance is None:
                raise ProductServiceError("用户不存在", 404)
            return int(balance)

    def list_users(self, limit: int = 500) -> list[dict[str, object]]:
        limit = max(1, min(1000, int(limit or 500)))
        with self.engine.begin() as connection:
            rows = connection.execute(
                select(product_users)
                .order_by(product_users.c.created_at.desc())
                .limit(limit)
            ).all()
        return [_public_user(row) for row in rows]

    def adjust_user_credits(self, user_id: str, amount: int) -> dict[str, object]:
        if amount == 0:
            raise ProductServiceError("调整额度不能为 0")
        now = _now()
        with self.engine.begin() as connection:
            user = connection.execute(select(product_users).where(product_users.c.id == user_id)).first()
            if user is None:
                raise ProductServiceError("用户不存在", 404)
            next_balance = int(user.credit_balance or 0) + int(amount)
            if next_balance < 0:
                raise ProductServiceError("用户额度不足，不能扣成负数")
            connection.execute(
                update(product_users)
                .where(product_users.c.id == user_id)
                .values(credit_balance=next_balance, updated_at=now)
            )
            connection.execute(insert(credit_ledger).values(
                id=str(uuid4()),
                user_id=user_id,
                delta=int(amount),
                balance_after=next_balance,
                type="admin_adjust",
                reference_id=None,
                created_at=now,
            ))
            updated_user = connection.execute(select(product_users).where(product_users.c.id == user_id)).one()
        return _public_user(updated_user)

    def create_cdks(self, count: int, credit_amount: int, created_by: str) -> list[dict[str, object]]:
        if count < 1 or count > 500:
            raise ProductServiceError("生成数量必须在 1 到 500 之间")
        if credit_amount < 1 or credit_amount > 1_000_000:
            raise ProductServiceError("额度必须大于 0")
        items: list[dict[str, object]] = []
        now = _now()
        with self.engine.begin() as connection:
            while len(items) < count:
                code = self._generate_cdk_code()
                code_hash = self._hash_cdk(code)
                item = {
                    "id": str(uuid4()),
                    "code_hash": code_hash,
                    "code_preview": self._preview_code(code),
                    "credit_amount": credit_amount,
                    "status": "unused",
                    "created_by": created_by,
                    "created_at": now,
                }
                try:
                    connection.execute(insert(cdks).values(**item))
                except IntegrityError:
                    continue
                items.append({"id": item["id"], "code": code, "credit_amount": credit_amount, "status": "unused"})
        return items

    def list_cdks(self, limit: int = 500) -> list[dict[str, object]]:
        limit = max(1, min(1000, int(limit or 500)))
        with self.engine.begin() as connection:
            rows = connection.execute(
                select(cdks, product_users.c.username.label("redeemed_by_username"))
                .outerjoin(product_users, cdks.c.redeemed_by_user_id == product_users.c.id)
                .order_by(cdks.c.created_at.desc())
                .limit(limit)
            ).all()
        result = []
        for row in rows:
            mapping = row._mapping
            result.append({
                "id": mapping[cdks.c.id],
                "code_preview": mapping[cdks.c.code_preview],
                "credit_amount": mapping[cdks.c.credit_amount],
                "status": mapping[cdks.c.status],
                "created_by": mapping[cdks.c.created_by],
                "created_at": mapping[cdks.c.created_at].isoformat() if mapping[cdks.c.created_at] else None,
                "redeemed_by_user_id": mapping[cdks.c.redeemed_by_user_id],
                "redeemed_by_username": mapping["redeemed_by_username"],
                "redeemed_at": mapping[cdks.c.redeemed_at].isoformat() if mapping[cdks.c.redeemed_at] else None,
            })
        return result

    def disable_cdk(self, cdk_id: str) -> dict[str, object]:
        with self.engine.begin() as connection:
            row = connection.execute(select(cdks).where(cdks.c.id == cdk_id)).first()
            if row is None:
                raise ProductServiceError("CDK 不存在", 404)
            if row.status == "redeemed":
                raise ProductServiceError("已兑换的 CDK 不能禁用")
            connection.execute(update(cdks).where(cdks.c.id == cdk_id).values(status="disabled"))
        return {"id": cdk_id, "status": "disabled"}

    def redeem_cdk(self, user_id: str, code: str) -> dict[str, object]:
        code_hash = self._hash_cdk(code)
        if not code_hash:
            raise ProductServiceError("请输入 CDK")
        now = _now()
        with self.engine.begin() as connection:
            cdk = connection.execute(select(cdks).where(cdks.c.code_hash == code_hash)).first()
            if cdk is None:
                raise ProductServiceError("CDK 无效", 404)
            if cdk.status == "disabled":
                raise ProductServiceError("CDK 已禁用", 400)
            if cdk.status == "redeemed":
                raise ProductServiceError("CDK 已被兑换", 409)
            user = connection.execute(select(product_users).where(product_users.c.id == user_id)).first()
            if user is None or not bool(user.enabled):
                raise ProductServiceError("用户不存在或已禁用", 404)
            updated = connection.execute(
                update(cdks)
                .where(and_(cdks.c.id == cdk.id, cdks.c.status == "unused"))
                .values(status="redeemed", redeemed_by_user_id=user_id, redeemed_at=now)
            )
            if updated.rowcount != 1:
                raise ProductServiceError("CDK 已被兑换", 409)
            next_balance = int(user.credit_balance or 0) + int(cdk.credit_amount)
            connection.execute(
                update(product_users)
                .where(product_users.c.id == user_id)
                .values(credit_balance=next_balance, updated_at=now)
            )
            connection.execute(insert(credit_ledger).values(
                id=str(uuid4()),
                user_id=user_id,
                delta=int(cdk.credit_amount),
                balance_after=next_balance,
                type="cdk_redeem",
                reference_id=cdk.id,
                created_at=now,
            ))
        return {"credited": int(cdk.credit_amount), "balance": next_balance}

    def start_image_job(
            self,
            user_id: str,
            prompt: str,
            model: str,
            cost: int = IMAGE_CREDIT_COST,
            kind: str = "generation",
            client_request_id: str | None = None,
    ) -> dict[str, object]:
        now = _now()
        job_id = str(uuid4())
        normalized_client_request_id = str(client_request_id or "").strip()[:96]
        with self.engine.begin() as connection:
            if normalized_client_request_id:
                existing_job = connection.execute(
                    select(image_generation_jobs).where(
                        image_generation_jobs.c.user_id == user_id,
                        image_generation_jobs.c.client_request_id == normalized_client_request_id,
                    )
                ).first()
                if existing_job is not None:
                    user = connection.execute(select(product_users).where(product_users.c.id == user_id)).first()
                    return {
                        "id": existing_job.id,
                        "cost": int(existing_job.credit_cost),
                        "balance": int(user.credit_balance or 0) if user is not None else 0,
                        "existing": True,
                    }
            user = connection.execute(select(product_users).where(product_users.c.id == user_id)).first()
            if user is None or not bool(user.enabled):
                raise ProductServiceError("用户不存在或已禁用", 404)
            current_balance = int(user.credit_balance or 0)
            if current_balance < cost:
                raise ProductServiceError("额度不足", 402)
            next_balance = current_balance - cost
            connection.execute(
                update(product_users)
                .where(product_users.c.id == user_id)
                .values(credit_balance=next_balance, updated_at=now)
            )
            connection.execute(insert(image_generation_jobs).values(
                id=job_id,
                user_id=user_id,
                status="reserved",
                kind=kind,
                client_request_id=normalized_client_request_id or None,
                credit_cost=cost,
                prompt=prompt,
                model=model,
                result_urls="[]",
                result_payload="",
                error_message="",
                created_at=now,
                updated_at=now,
            ))
            connection.execute(insert(credit_ledger).values(
                id=str(uuid4()),
                user_id=user_id,
                delta=-cost,
                balance_after=next_balance,
                type="image_consume",
                reference_id=job_id,
                created_at=now,
            ))
        return {"id": job_id, "cost": cost, "balance": next_balance}

    def mark_image_job_running(self, job_id: str) -> bool:
        with self.engine.begin() as connection:
            result = connection.execute(
                update(image_generation_jobs)
                .where(image_generation_jobs.c.id == job_id, image_generation_jobs.c.status == "reserved")
                .values(status="running", updated_at=_now())
            )
            return result.rowcount == 1

    def complete_image_job(self, job_id: str, result: object) -> None:
        now = _now()
        urls = _collect_urls(result)
        with self.engine.begin() as connection:
            connection.execute(
                update(image_generation_jobs)
                .where(image_generation_jobs.c.id == job_id, image_generation_jobs.c.status.in_(["reserved", "running"]))
                .values(
                    status="succeeded",
                    result_urls=json.dumps(urls, ensure_ascii=False),
                    result_payload="",
                    updated_at=now,
                    completed_at=now,
                )
            )

    def refund_image_job(self, job_id: str, error_message: str = "") -> None:
        now = _now()
        with self.engine.begin() as connection:
            job = connection.execute(select(image_generation_jobs).where(image_generation_jobs.c.id == job_id)).first()
            if job is None or job.status not in {"reserved", "running"}:
                return
            user = connection.execute(select(product_users).where(product_users.c.id == job.user_id)).first()
            if user is None:
                return
            next_balance = int(user.credit_balance or 0) + int(job.credit_cost)
            connection.execute(
                update(product_users)
                .where(product_users.c.id == job.user_id)
                .values(credit_balance=next_balance, updated_at=now)
            )
            connection.execute(insert(credit_ledger).values(
                id=str(uuid4()),
                user_id=job.user_id,
                delta=int(job.credit_cost),
                balance_after=next_balance,
                type="image_refund",
                reference_id=job.id,
                created_at=now,
            ))
            connection.execute(
                update(image_generation_jobs)
                .where(image_generation_jobs.c.id == job.id)
                .values(status="refunded", error_message=error_message, updated_at=now, completed_at=now)
            )

    def get_image_job(self, user_id: str, job_id: str) -> dict[str, object]:
        with self.engine.begin() as connection:
            job = connection.execute(
                select(image_generation_jobs).where(
                    image_generation_jobs.c.id == job_id,
                    image_generation_jobs.c.user_id == user_id,
                )
            ).first()
            if job is None:
                raise ProductServiceError("任务不存在", 404)
            return _public_image_job(job)

    def list_user_image_history(self, user_id: str, limit: int = 100) -> list[dict[str, object]]:
        limit = max(1, min(500, int(limit or 100)))
        with self.engine.begin() as connection:
            rows = connection.execute(
                select(image_generation_jobs)
                .where(
                    image_generation_jobs.c.user_id == user_id,
                    image_generation_jobs.c.status == "succeeded",
                )
                .order_by(image_generation_jobs.c.completed_at.desc(), image_generation_jobs.c.created_at.desc())
                .limit(limit)
            ).all()
        return [_public_image_job(row, include_result=False) for row in rows]

    def delete_user_image_history_item(self, user_id: str, job_id: str) -> None:
        with self.engine.begin() as connection:
            result = connection.execute(
                delete(image_generation_jobs).where(
                    image_generation_jobs.c.id == job_id,
                    image_generation_jobs.c.user_id == user_id,
                )
            )
            if result.rowcount != 1:
                raise ProductServiceError("图片不存在", 404)

    def clear_user_image_history(self, user_id: str) -> None:
        with self.engine.begin() as connection:
            connection.execute(delete(image_generation_jobs).where(image_generation_jobs.c.user_id == user_id))

    def fail_image_job_without_refund(self, job_id: str, error_message: str = "") -> None:
        now = _now()
        with self.engine.begin() as connection:
            connection.execute(
                update(image_generation_jobs)
                .where(image_generation_jobs.c.id == job_id, image_generation_jobs.c.status.in_(["reserved", "running"]))
                .values(status="failed", error_message=error_message, updated_at=now, completed_at=now)
            )

    def _issue_session(self, user: Any) -> dict[str, object]:
        token = secrets.token_urlsafe(32)
        now = _now()
        with self.engine.begin() as connection:
            connection.execute(insert(product_sessions).values(
                id=str(uuid4()),
                user_id=user.id,
                token_hash=_hash_value(token),
                expires_at=now + timedelta(days=SESSION_TTL_DAYS),
                created_at=now,
            ))
        public_user = _public_user(user)
        return {
            "ok": True,
            "token": token,
            "role": "customer",
            "subject_id": public_user["id"],
            "name": public_user["username"],
            "user": public_user,
            "credit_balance": public_user["credit_balance"],
        }

    def _validate_credentials(self, username: str, password: str) -> None:
        if not USERNAME_PATTERN.match(username):
            raise ProductServiceError("用户名需为 3-32 位字母、数字、下划线、点、横线或 @")
        if len(str(password or "")) < 6:
            raise ProductServiceError("密码至少需要 6 位")

    def _generate_cdk_code(self) -> str:
        alphabet = string.ascii_uppercase + string.digits
        body = "".join(secrets.choice(alphabet) for _ in range(20))
        return "CDK-{}-{}-{}-{}".format(body[:5], body[5:10], body[10:15], body[15:])

    def _hash_cdk(self, code: str) -> str:
        normalized = str(code or "").strip().upper().replace(" ", "")
        return _hash_value(normalized) if normalized else ""

    def _preview_code(self, code: str) -> str:
        normalized = str(code or "").strip().upper()
        return f"{normalized[:9]}...{normalized[-4:]}"


product_service = ProductService()
