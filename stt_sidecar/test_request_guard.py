"""request_guard.RequestGuard driven directly over ASGI: no FastAPI app behind it."""
import asyncio
import hmac
import json

import pytest
from fastapi import HTTPException

import request_guard
from request_guard import GuardLimits, RequestGuard

LIMITS = GuardLimits(api_key="", max_upload_bytes=1000, max_in_flight=1)


def scope(path="/transcribe", method="POST", headers=()):
    return {"type": "http", "method": method, "path": path,
            "headers": [(k.lower().encode(), v.encode()) for k, v in headers]}


class Exchange:
    """Records what the guard sends and how much of the body anyone read."""
    def __init__(self, chunks=(b"",)):
        self.chunks, self.reads, self.sent = list(chunks), 0, []

    async def receive(self):
        self.reads += 1
        if self.chunks:
            body = self.chunks.pop(0)
            return {"type": "http.request", "body": body, "more_body": bool(self.chunks)}
        return {"type": "http.disconnect"}

    async def send(self, message):
        self.sent.append(message)

    @property
    def status(self):
        return next(m["status"] for m in self.sent if m["type"] == "http.response.start")

    @property
    def headers(self):
        start = next(m for m in self.sent if m["type"] == "http.response.start")
        return {k.decode(): v.decode() for k, v in start["headers"]}

    @property
    def detail(self):
        body = b"".join(m.get("body", b"") for m in self.sent if m["type"] == "http.response.body")
        return json.loads(body)["detail"]


class ReadingApp:
    """Reads the whole body, then answers 200 (optionally after `gate` opens)."""
    def __init__(self, gate=None):
        self.calls, self.gate, self.entered = 0, gate, asyncio.Event() if gate else None

    async def __call__(self, scope, receive, send):
        self.calls += 1
        if self.gate:
            self.entered.set()
            await self.gate.wait()
        while (await receive()).get("more_body"):
            pass
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})


def run(guard, request_scope, exchange):
    asyncio.run(guard(request_scope, exchange.receive, exchange.send))


# ── access key ───────────────────────────────────────────────────────────────

def test_without_a_key_requests_pass_through():
    inner, ex = ReadingApp(), Exchange()
    run(RequestGuard(inner, lambda: LIMITS), scope(), ex)
    assert inner.calls == 1 and ex.status == 200


@pytest.mark.parametrize("path,method", [("/transcribe", "POST"), ("/docs", "GET"), ("/openapi.json", "GET")])
def test_with_a_key_everything_but_health_needs_it(path, method):
    limits = GuardLimits(api_key="k3y", max_upload_bytes=1000, max_in_flight=1)
    inner, ex = ReadingApp(), Exchange()
    run(RequestGuard(inner, lambda: limits), scope(path, method), ex)
    assert ex.status == 401 and ex.detail == "Missing or wrong access key."
    assert ex.headers.get("www-authenticate") == "Bearer"
    assert inner.calls == 0 and ex.reads == 0  # refused before the upload is read


def test_health_never_needs_the_key():
    limits = GuardLimits(api_key="k3y", max_upload_bytes=1000, max_in_flight=1)
    inner, ex = ReadingApp(), Exchange()
    run(RequestGuard(inner, lambda: limits), scope("/health", "GET"), ex)
    assert inner.calls == 1 and ex.status == 200


def test_the_key_is_compared_in_constant_time(monkeypatch):
    compared, real_compare = [], hmac.compare_digest
    def spy(a, b):
        compared.append((a, b))
        return real_compare(a, b)
    monkeypatch.setattr(request_guard.hmac, "compare_digest", spy)
    limits = GuardLimits(api_key="k3y", max_upload_bytes=1000, max_in_flight=1)
    inner, ex = ReadingApp(), Exchange()
    run(RequestGuard(inner, lambda: limits), scope(headers=[("Authorization", "Bearer k3y")]), ex)
    assert ex.status == 200 and compared == [(b"k3y", b"k3y")]


# ── upload size ──────────────────────────────────────────────────────────────

def test_a_declared_length_over_the_limit_is_refused_before_reading(monkeypatch):
    monkeypatch.setattr(request_guard, "FORM_OVERHEAD_BYTES", 100)
    inner, ex = ReadingApp(), Exchange([b"x" * 2000])
    run(RequestGuard(inner, lambda: LIMITS), scope(headers=[("Content-Length", "1101")]), ex)
    assert ex.status == 413 and "STT_MAX_UPLOAD_BYTES" in ex.detail
    assert inner.calls == 0 and ex.reads == 0


def test_a_declared_length_within_the_limit_and_form_overhead_passes(monkeypatch):
    monkeypatch.setattr(request_guard, "FORM_OVERHEAD_BYTES", 100)
    inner, ex = ReadingApp(), Exchange([b"x" * 1100])
    run(RequestGuard(inner, lambda: LIMITS), scope(headers=[("Content-Length", "1100")]), ex)
    assert ex.status == 200


def test_a_body_longer_than_declared_or_undeclared_is_cut_off_while_streaming(monkeypatch):
    monkeypatch.setattr(request_guard, "FORM_OVERHEAD_BYTES", 0)
    inner, ex = ReadingApp(), Exchange([b"x" * 600, b"x" * 600, b"x" * 600])
    with pytest.raises(HTTPException) as err:
        run(RequestGuard(inner, lambda: LIMITS), scope(), ex)
    assert err.value.status_code == 413
    assert ex.reads == 2  # stopped at the chunk that crossed the limit


def test_size_limits_only_apply_to_uploads():
    inner, ex = ReadingApp(), Exchange([b"x" * 5000])
    run(RequestGuard(inner, lambda: LIMITS), scope("/health", "GET", [("Content-Length", "5000")]), ex)
    assert ex.status == 200


# ── bounded admission ────────────────────────────────────────────────────────

def test_requests_beyond_the_in_flight_limit_are_busy():
    async def scenario():
        gate = asyncio.Event()
        inner = ReadingApp(gate)
        guard = RequestGuard(inner, lambda: LIMITS)  # one request in flight at most
        first, second, third = Exchange(), Exchange(), Exchange()
        running = asyncio.create_task(guard(scope(), first.receive, first.send))
        await inner.entered.wait()
        await guard(scope(), second.receive, second.send)
        gate.set()
        await running
        await guard(scope(), third.receive, third.send)  # admitted again once the first left
        return inner, first, second, third
    inner, first, second, third = asyncio.run(scenario())
    assert second.status == 503 and second.detail == "busy"
    assert int(second.headers["retry-after"]) > 0
    assert second.reads == 0
    assert first.status == 200 and third.status == 200 and inner.calls == 2


def test_a_failed_request_leaves_the_queue():
    class Exploding:
        async def __call__(self, scope, receive, send):
            raise RuntimeError("boom")
    guard = RequestGuard(Exploding(), lambda: LIMITS)
    for _ in range(3):
        with pytest.raises(RuntimeError):
            run(guard, scope(), Exchange())
    guard_ok = RequestGuard(ReadingApp(), lambda: LIMITS)
    ex = Exchange()
    run(guard_ok, scope(), ex)
    assert ex.status == 200
    assert guard.in_flight == 0


def test_lifespan_and_other_scopes_pass_through():
    seen = []
    async def inner(scope, receive, send):
        seen.append(scope["type"])
    asyncio.run(RequestGuard(inner, lambda: LIMITS)({"type": "lifespan"}, None, None))
    assert seen == ["lifespan"]


@pytest.mark.parametrize("limit,shown", [(2 * 1024 ** 3, "2.0 GiB"), (200 * 1024 ** 2, "200.0 MiB"), (1000, "1000 bytes")])
def test_the_size_limit_is_shown_in_a_readable_unit(limit, shown):
    assert f"({shown};" in request_guard.too_large_detail(limit)
