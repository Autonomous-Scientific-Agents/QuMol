"""Small, dependency-free protections for a public-facing server.

- BodyLimit: rejects request bodies over a size cap (uvicorn has none by default).
- SecurityHeaders: CSP and friends on every response.
- RateLimiter: in-memory sliding-window limits (one process; fine for one server).
- compute_slot: caps how many optimizations run at once so the box can't be swamped.
"""

from __future__ import annotations

import os
import shutil
import threading
import time
from collections import defaultdict, deque
from contextlib import contextmanager

from fastapi import HTTPException

MAX_BODY_BYTES = int(os.environ.get("QUMOL_MAX_BODY", 256 * 1024))

CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",   # RDKit runs as WebAssembly
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
])
HEADERS = [
    (b"content-security-policy", CSP.encode()),
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"no-referrer"),
    (b"x-frame-options", b"DENY"),
    (b"cross-origin-opener-policy", b"same-origin"),
    (b"permissions-policy", b"camera=(), microphone=(), geolocation=(), payment=(), usb=()"),
    (b"strict-transport-security", b"max-age=31536000"),
]


async def _send_simple(send, status: int, text: str):
    body = text.encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"text/plain; charset=utf-8"),
                            (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


class _TooLarge(Exception):
    pass


class BodyLimit:
    def __init__(self, app, max_bytes: int = MAX_BODY_BYTES):
        self.app, self.max = app, max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        cl = dict(scope.get("headers") or []).get(b"content-length")
        if cl is not None:
            try:
                if int(cl) > self.max:
                    return await _send_simple(send, 413, "Request too large")
            except ValueError:
                return await _send_simple(send, 400, "Bad Content-Length")
        seen = 0
        started = False

        async def limited_receive():
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > self.max:
                    raise _TooLarge
            return msg

        async def tracking_send(msg):
            nonlocal started
            if msg["type"] == "http.response.start":
                started = True
            await send(msg)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except _TooLarge:
            if not started:
                await _send_simple(send, 413, "Request too large")


class SecurityHeaders:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        path = scope.get("path", "")
        # Game files must be re-checked on every load, or browsers keep running an old app.js
        # against a new index.html after a deploy (an unchanged file costs a 304). The vendored
        # libraries are pinned by checksum, so they may be cached for a day.
        if path.startswith("/api/"):
            cache = None
        elif path.startswith("/vendor/"):
            cache = b"public, max-age=86400"
        else:
            cache = b"no-cache"

        async def send_with_headers(msg):
            if msg["type"] == "http.response.start":
                names = {k.lower() for k, _ in msg.get("headers", [])}
                extra = [h for h in HEADERS if h[0] not in names]
                if cache and b"cache-control" not in names:
                    extra.append((b"cache-control", cache))
                msg["headers"] = list(msg.get("headers", [])) + extra
            await send(msg)

        await self.app(scope, receive, send_with_headers)


class RateLimiter:
    def __init__(self):
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, key: str, limit: int, window: float) -> None:
        """Record one hit for ``key``; raise 429 if over ``limit`` within ``window`` seconds."""
        now = time.monotonic()
        with self._lock:
            dq = self._hits[key]
            while dq and dq[0] <= now - window:
                dq.popleft()
            if len(dq) >= limit:
                retry = max(1, int(window - (now - dq[0])) + 1)
                raise HTTPException(429, f"Too many requests. Try again in {retry} s.",
                                    headers={"Retry-After": str(retry)})
            dq.append(now)
            if len(self._hits) > 20000:  # keep memory bounded
                for k in [k for k, v in self._hits.items() if not v or v[-1] <= now - 3600]:
                    del self._hits[k]

    def reset(self):
        with self._lock:
            self._hits.clear()
        read_cache.clear()


limiter = RateLimiter()

def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


_slots = threading.BoundedSemaphore(env_int("QUMOL_WORKERS", 2))


@contextmanager
def compute_slot(timeout: float = 2.0):
    """Cap concurrent optimizations. Waits only briefly, so queued requests can't pile up
    and starve the web server's thread pool; callers get 503 instead."""
    if not _slots.acquire(timeout=timeout):
        raise HTTPException(503, "The server is busy optimizing other molecules. Try again in a few seconds.",
                            headers={"Retry-After": "5"})
    try:
        yield
    finally:
        _slots.release()


_inflight: set = set()
_inflight_lock = threading.Lock()


@contextmanager
def one_at_a_time(key):
    """Allow a single in-flight request per key (e.g. per player)."""
    with _inflight_lock:
        if key in _inflight:
            raise HTTPException(429, "Your previous molecule is still being scored.", headers={"Retry-After": "3"})
        _inflight.add(key)
    try:
        yield
    finally:
        with _inflight_lock:
            _inflight.discard(key)


MIN_FREE_BYTES = env_int("QUMOL_MIN_FREE_MB", 1024) * 1024 * 1024


def ensure_disk_space(path) -> None:
    """Refuse new data when the disk holding the database is nearly full."""
    try:
        free = shutil.disk_usage(os.path.dirname(os.path.abspath(path)) or ".").free
    except OSError:
        return
    if free < MIN_FREE_BYTES:
        raise HTTPException(503, "The server is out of storage space. Please try again later.")


class TTLCache:
    """Tiny time-based cache for expensive read-only queries."""

    def __init__(self, ttl: float):
        self.ttl, self._data, self._lock = ttl, {}, threading.Lock()

    def get(self, key, compute):
        now = time.monotonic()
        with self._lock:
            hit = self._data.get(key)
            if hit and hit[0] > now:
                return hit[1]
        value = compute()
        with self._lock:
            if len(self._data) > 200:
                self._data.clear()
            self._data[key] = (now + self.ttl, value)
        return value

    def clear(self):
        with self._lock:
            self._data.clear()


read_cache = TTLCache(env_int("QUMOL_CACHE_SECONDS", 30))
