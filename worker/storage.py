"""File storage. Vercel Blob in production (hosted https URLs, required by AR Quick Look);
a local folder when BLOB_READ_WRITE_TOKEN is empty (dev and tests only: local:// URLs never
reach the demo because demo_check rejects anything that is not https)."""
from __future__ import annotations

import logging
from pathlib import Path

import httpx

from .config import WORKER_DIR, get_settings
from .limits import ProviderError, classify_http

log = logging.getLogger("worker.storage")
BLOB_API = "https://blob.vercel-storage.com"
LOCAL_DIR = WORKER_DIR / ".localstore"
USDZ_MIME = "model/vnd.usdz+zip"
GLB_MIME = "model/gltf-binary"


class Storage:
    def __init__(self, token: str | None = None, client: httpx.Client | None = None):
        self.token = get_settings().blob_token if token is None else token
        self.client = client or httpx.Client(timeout=httpx.Timeout(120, connect=15))

    @property
    def hosted(self) -> bool:
        return bool(self.token)

    def put(self, pathname: str, data: bytes, content_type: str) -> str:
        """Deterministic path, overwrite allowed: re-running a stage never duplicates files."""
        pathname = pathname.lstrip("/")
        if not self.token:
            p = LOCAL_DIR / pathname
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            return f"local://{pathname}"
        try:
            r = self.client.put(
                f"{BLOB_API}/{pathname}", content=data,
                headers={
                    "authorization": f"Bearer {self.token}",
                    "x-api-version": "7",
                    "x-content-type": content_type,
                    "x-add-random-suffix": "0",
                    "x-allow-overwrite": "1",
                    "x-cache-control-max-age": "31536000",
                })
        except httpx.HTTPError as e:
            raise ProviderError(f"blob upload network error: {e}", retryable=True) from e
        if r.status_code >= 400:
            raise classify_http(r.status_code, r.text, r.headers.get("retry-after"), "blob")
        url = r.json().get("url")
        if not url:
            raise ProviderError(f"blob upload returned no url: {r.text[:200]}")
        return url

    def get(self, url: str) -> bytes:
        if url.startswith("local://"):
            return (LOCAL_DIR / url[len("local://"):]).read_bytes()
        return fetch_bytes(url, self.client)


def fetch_bytes(url: str, client: httpx.Client | None = None, max_mb: float = 60, timeout: float = 60) -> bytes:
    c = client or httpx.Client(timeout=httpx.Timeout(timeout, connect=15))
    try:
        r = c.get(url, follow_redirects=True, headers={"user-agent": "Mozilla/5.0 (FitCheck worker)"})
    except httpx.HTTPError as e:
        raise ProviderError(f"download failed: {e}", retryable=True) from e
    if r.status_code in (403, 404, 410):
        raise ProviderError(f"download {r.status_code} (gone)", retryable=False, status=r.status_code)
    if r.status_code >= 400:
        raise classify_http(r.status_code, "", r.headers.get("retry-after"), "download")
    if len(r.content) > max_mb * 1024 * 1024:
        raise ProviderError(f"download too large: {len(r.content)} bytes")
    return r.content
