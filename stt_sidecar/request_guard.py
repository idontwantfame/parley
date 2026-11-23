"""ASGI guard in front of the sidecar: shared-secret auth, an upload size cap
and bounded admission for /transcribe.

It runs before FastAPI parses the multipart body, so a wrong key, a declared
oversize upload or a full queue is refused before any of the upload is read
or spooled to disk. Uploads without a (truthful) Content-Length are counted
while they stream in and cut off once they pass the cap.
"""
from __future__ import annotations

import hmac
import logging
import threading
from dataclasses import dataclass
from typing import Callable, Optional

from fastapi import HTTPException
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

log = logging.getLogger("stt_sidecar.guard")

# /health stays open: the compose healthcheck and the bot's capability probe use it.
OPEN_PATHS = frozenset({"/health"})
UPLOAD_ROUTE = ("POST", "/transcribe")
# The body is the file plus a few small form fields (model, language, up to
# 128 KiB of vocabulary) and multipart framing; allow for them on top of the
# file limit. The exact file size is checked again after parsing.
FORM_OVERHEAD_BYTES = 1024 * 1024
AUTH_FAILED = "Missing or wrong access key."
BUSY = "busy"
BUSY_RETRY_AFTER_SECONDS = 5
_UNITS = (("GiB", 1024 ** 3), ("MiB", 1024 ** 2), ("KiB", 1024))


@dataclass(frozen=True)
class GuardLimits:
    api_key: str           # "" = no key required
    max_upload_bytes: int  # per uploaded file
    max_in_flight: int     # /transcribe requests admitted at once (running + waiting)


def _readable_size(size: int) -> str:
    for unit, scale in _UNITS:
        if size >= scale:
            return f"{size / scale:.1f} {unit}"
    return f"{size} bytes"


def too_large_detail(limit: int) -> str:
    return (f"The upload is larger than this sidecar accepts ({_readable_size(limit)}; "
            "raise STT_MAX_UPLOAD_BYTES on the sidecar to allow more).")


def _header(scope: Scope, name: bytes) -> Optional[str]:
    for key, value in scope.get("headers", []):
        if key.lower() == name:
            return value.decode("latin-1")
    return None


def _authorized(scope: Scope, api_key: str) -> bool:
    """Bearer <key>, compared in constant time."""
    scheme, _, token = (_header(scope, b"authorization") or "").strip().partition(" ")
    if scheme.lower() != "bearer":
        return False
    return hmac.compare_digest(token.strip().encode(), api_key.encode())


def _declared_length(scope: Scope) -> Optional[int]:
    value = _header(scope, b"content-length")
    return int(value) if value and value.strip().isdigit() else None


def _capped(receive: Receive, max_body: int, max_upload: int) -> Receive:
    """`receive`, refusing the upload with a 413 once the body passes `max_body`."""
    received = 0

    async def capped_receive() -> Message:
        nonlocal received
        message = await receive()
        if message["type"] == "http.request":
            received += len(message.get("body", b""))
            if received > max_body:
                log.warning("Refused an upload: the body passed %d bytes", max_body)
                raise HTTPException(413, too_large_detail(max_upload))
        return message

    return capped_receive


async def _reply(scope: Scope, receive: Receive, send: Send, status: int, detail: str,
                 headers: Optional[dict[str, str]] = None) -> None:
    await JSONResponse({"detail": detail}, status_code=status, headers=headers)(scope, receive, send)


class RequestGuard:
    """Pure ASGI middleware. `limits` is read per request, so settings can change at runtime (tests)."""

    def __init__(self, app: ASGIApp, limits: Callable[[], GuardLimits]) -> None:
        self.app = app
        self._limits = limits
        # Requests are admitted on the event loop, but a lock keeps the count
        # right even with several loops (e.g. the test client's threads).
        self._lock = threading.Lock()
        self.in_flight = 0

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limits = self._limits()
        if limits.api_key and scope["path"] not in OPEN_PATHS and not _authorized(scope, limits.api_key):
            await _reply(scope, receive, send, 401, AUTH_FAILED, {"WWW-Authenticate": "Bearer"})
            return
        if (scope["method"], scope["path"]) != UPLOAD_ROUTE:
            await self.app(scope, receive, send)
            return
        await self._upload(scope, receive, send, limits)

    async def _upload(self, scope: Scope, receive: Receive, send: Send, limits: GuardLimits) -> None:
        max_body = limits.max_upload_bytes + FORM_OVERHEAD_BYTES
        declared = _declared_length(scope)
        if declared is not None and declared > max_body:
            await _reply(scope, receive, send, 413, too_large_detail(limits.max_upload_bytes))
            return
        if not self._admit(limits.max_in_flight):
            log.warning("Refused a transcription: %d already running or queued", limits.max_in_flight)
            await _reply(scope, receive, send, 503, BUSY, {"Retry-After": str(BUSY_RETRY_AFTER_SECONDS)})
            return
        try:
            await self.app(scope, _capped(receive, max_body, limits.max_upload_bytes), send)
        finally:
            self._leave()

    def _admit(self, max_in_flight: int) -> bool:
        with self._lock:
            if self.in_flight >= max_in_flight:
                return False
            self.in_flight += 1
            return True

    def _leave(self) -> None:
        with self._lock:
            self.in_flight -= 1
