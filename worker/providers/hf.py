"""Hugging Face ZeroGPU spaces (tertiary provider, spec 6.4 + pitfall 1).

Free ZeroGPU gives each account only a few GPU minutes: about 3 requests per day per token, and the
quota resets 24 h after first use. So: HF is last in the chain, capped at 3/day per token on a
first-use window, and never relied on during the demo.

Live test, Nov 14 2026 (real cutout of an accent chair):
  trellis-community/TRELLIS    WORKS: 54 s, 62k tris, textured. Raw GLB omits metallicFactor (renders black until
                               our export sets metallic 0; the exported model has the right colours).
  stabilityai/stable-fast-3d   /run_button raises a hidden AppError (also after /requires_bg_remove): kept second
                               in the list so it is tried only if TRELLIS fails.
HF_SPACE_IMAGE_TO_3D may list several, comma separated, tried in order.
"""
from __future__ import annotations

import logging
import os
import tempfile
import threading
import uuid

from ..limits import ProviderError
from . import PollResult, Provider, View

log = logging.getLogger("worker.hf")
DEFAULT_SPACES = "trellis-community/TRELLIS,stabilityai/stable-fast-3d"


def _map_error(e: Exception) -> ProviderError:
    msg = str(e)
    low = msg.lower()
    if "quota" in low or "exceeded" in low and "gpu" in low or "zerogpu" in low and "limit" in low:
        return ProviderError(f"hf quota: {msg[:160]}", quota=True, quota_kind="day")
    if "401" in low or "unauthorized" in low or "invalid token" in low:
        return ProviderError(f"hf auth: {msg[:160]}", quota=True, quota_kind="day")
    if any(s in low for s in ("timeout", "timed out", "connection", "503", "502", "queue is full")):
        return ProviderError(f"hf transient: {msg[:160]}", retryable=True)
    return ProviderError(f"hf: {msg[:200]}")


def _run_space(space: str, token: str, png_path: str, extra_paths: list[str]) -> str:
    """Blocking call into one space. Returns the local path of the GLB it produced."""
    from gradio_client import Client, handle_file

    # the client's default HTTP read timeout is a few seconds; a queued ZeroGPU call needs minutes
    client = Client(space, token=token, verbose=False, httpx_kwargs={"timeout": 300})
    if "TRELLIS" in space.upper():
        client.predict(api_name="/start_session")
        client.predict(image=handle_file(png_path), api_name="/preprocess_image")   # the UI always runs this first
        multi = [{"image": handle_file(p), "caption": None} for p in extra_paths] if extra_paths else []
        out = client.predict(image=handle_file(png_path), multiimages=multi, seed=0,
                             ss_guidance_strength=7.5, ss_sampling_steps=12,
                             slat_guidance_strength=3.0, slat_sampling_steps=12,
                             multiimage_algo="stochastic", mesh_simplify=0.95, texture_size=1024,
                             api_name="/generate_and_extract_glb")
        glb = out[2] or out[1]
    elif "stable-fast-3d" in space:
        out = client.predict(input_image=handle_file(png_path), foreground_ratio=0.85, remesh_option="None",
                             vertex_count=-1, texture_size=1024, api_name="/run_button")
        glb = out[1]
    else:
        raise ProviderError(f"no adapter for HF space {space}: add one in worker/providers/hf.py")
    if isinstance(glb, dict):
        glb = glb.get("path") or glb.get("value")
    if not glb or not os.path.exists(glb):
        raise ProviderError(f"{space} returned no GLB file")
    return glb


class HuggingFace(Provider):
    name = "hf"
    timeout_s = 240
    per_minute = 2
    daily_window_from_first_use = True      # quota resets 24 h after first use
    supports_multi = False

    def __init__(self, tokens, space: str = "", per_day: int = 3, client=None):
        super().__init__(tokens, client)
        self.per_day = per_day
        self.spaces = [s.strip() for s in (space or DEFAULT_SPACES).split(",") if s.strip()]
        self._jobs: dict[str, dict] = {}

    def submit(self, views: list[View], key: str) -> str:
        job_id = uuid.uuid4().hex[:12]
        tmp = tempfile.mkdtemp(prefix="FitCheck_hf_")
        paths = []
        for i, v in enumerate(views[:1]):       # single best photo: the spaces' multi-image modes are unreliable
            p = os.path.join(tmp, f"view{i}.png")
            with open(p, "wb") as f:
                f.write(v.png)
            paths.append(p)
        state: dict = {"done": False, "glb": None, "error": None}

        def work() -> None:
            last: Exception | None = None
            for space in self.spaces:
                try:
                    with open(_run_space(space, key, paths[0], paths[1:]), "rb") as f:
                        state["glb"] = f.read()
                    state["space"] = space
                    break
                except Exception as e:  # noqa: BLE001
                    last = e if isinstance(e, ProviderError) else _map_error(e)
                    log.info("hf space %s failed: %s", space, last)
                    if getattr(last, "quota", False):
                        break               # the token is out of GPU time: other spaces will fail too
            if state["glb"] is None:
                state["error"] = last or ProviderError("hf: no space produced a model")
            state["done"] = True

        threading.Thread(target=work, daemon=True, name=f"hf-{job_id}").start()
        self._jobs[job_id] = state
        return job_id

    def poll(self, job_id: str, key: str) -> PollResult:
        state = self._jobs.get(job_id)
        if state is None:
            return PollResult("failed", error="job lost (worker restarted)")
        if not state["done"]:
            return PollResult("running")
        self._jobs.pop(job_id, None)
        if state["glb"]:
            return PollResult("done", glb=state["glb"])
        err = state["error"]
        if isinstance(err, ProviderError) and err.quota:
            raise err                           # the gen stage cools this token down
        return PollResult("failed", error=str(err))
