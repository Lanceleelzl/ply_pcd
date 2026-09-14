# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import hashlib
import hmac
from contextvars import ContextVar
from dataclasses import dataclass

from fastapi import HTTPException
from starlette.responses import JSONResponse


@dataclass(frozen=True)
class Principal:
    key_id: str
    role: str

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


@dataclass(frozen=True)
class ApiKeyRecord:
    principal: Principal
    digest: str


class ApiKeyAuthenticator:
    def __init__(self, enabled: bool, specification: str) -> None:
        self.enabled = enabled
        self.records = self._parse(specification)
        if enabled and not self.records:
            raise ValueError("REGISTRATION_API_KEY_HASHES is required when authentication is enabled")

    @staticmethod
    def _parse(specification: str) -> tuple[ApiKeyRecord, ...]:
        records = []
        seen = set()
        for item in filter(None, (value.strip() for value in specification.split(","))):
            parts = item.split(":")
            if len(parts) != 3:
                raise ValueError("API key records must use key_id:role:sha256 format")
            key_id, role, digest = parts
            if not key_id or key_id in seen or role not in {"user", "admin"}:
                raise ValueError("API key id must be unique and role must be user or admin")
            if len(digest) != 64 or any(character not in "0123456789abcdefABCDEF" for character in digest):
                raise ValueError("API key digest must be a SHA-256 hexadecimal value")
            seen.add(key_id)
            records.append(ApiKeyRecord(Principal(key_id, role), digest.lower()))
        return tuple(records)

    def authenticate(self, api_key: str | None) -> Principal | None:
        if not self.enabled:
            return Principal("anonymous", "admin")
        if not api_key:
            return None
        supplied = hashlib.sha256(api_key.encode("utf-8")).hexdigest()
        match = None
        for record in self.records:
            if hmac.compare_digest(supplied, record.digest):
                match = record.principal
        return match


_principal_context: ContextVar[Principal] = ContextVar(
    "registration_principal", default=Principal("anonymous", "admin")
)


def current_principal() -> Principal:
    return _principal_context.get()


def authorize_resource(resource: dict) -> None:
    if not resource_owned_by(current_principal(), resource.get("owner_id")):
        raise HTTPException(status_code=404, detail="Resource not found")


class ApiKeyAuthMiddleware:
    def __init__(self, app, authenticator: ApiKeyAuthenticator) -> None:
        self.app = app
        self.authenticator = authenticator

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/v2"):
            await self.app(scope, receive, send)
            return
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        raw_key = headers.get(b"x-api-key")
        principal = self.authenticator.authenticate(raw_key.decode("utf-8") if raw_key else None)
        if principal is None:
            response = JSONResponse(
                {"detail": "Not authenticated"}, status_code=401,
                headers={"WWW-Authenticate": "APIKey"},
            )
            await response(scope, receive, send)
            return
        token = _principal_context.set(principal)
        try:
            await self.app(scope, receive, send)
        finally:
            _principal_context.reset(token)


def resource_owned_by(principal: Principal, owner_id: str | None) -> bool:
    return principal.is_admin or owner_id == principal.key_id
