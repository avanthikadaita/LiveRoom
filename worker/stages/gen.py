"""Stage: gen (spec 6.4). Image-to-3D through the provider chain, resumable and non-blocking.

Each call (1) polls jobs that are already running, then (2) starts new jobs while a key is free.
State is in Neon: assets.provider_job = '<provider>:<keyhash>:<job id>', assets.gen_state =
{tried: [...], started_at, raw_glb_url}. A worker restart picks the jobs up again.

Chain: Tripo -> Meshy (if keys) -> Hugging Face -> generic fallback (is_approx_model = true).
REAL_3D_FOR=pinned (default) spends scarce provider credits only on demo_pin listings; everything
else gets the generic model right away and is upgraded automatically if it is pinned later.
"""
from __future__ import annotations

import hashlib
import logging
import os
from datetime import datetime, timezone

from ..config import ROOT
from ..context import Ctx
from ..db import WORKER_ID, jsonb
from ..glbtools import inspect_glb
from ..limits import ProviderError, QuotaExceeded, key_hash
from ..providers import Provider, View
from ..storage import GLB_MIME

log = logging.getLogger("worker.gen")
GENERIC_DIR = ROOT / "assets" / "generic"


def real_3d_policy() -> str:
    return os.getenv("REAL_3D_FOR", "pinned").strip().lower()     # pinned | all | none


def _state(asset: dict) -> dict:
    return dict(asset.get("gen_state") or {})


def _save_state(ctx: Ctx, lid: int, state: dict, **cols) -> None:
    sets, params = ["gen_state = %(gs)s", "updated_at = now()"], {"gs": jsonb(state), "id": lid}
    for k, v in cols.items():
        sets.append(f"{k} = %({k})s")
        params[k] = v
    ctx.db.x(f"update assets set {', '.join(sets)} where listing_id = %(id)s", params)


def _provider_failed(ctx: Ctx, asset: dict, provider: str, reason: str) -> None:
    """Mark this provider as tried for this asset; the next call moves down the chain."""
    lid = asset["listing_id"]
    state = _state(asset)
    state["tried"] = sorted(set(state.get("tried", [])) | {provider})
    state.pop("started_at", None)
    _save_state(ctx, lid, state, provider_job=None, locked_by=None, locked_at=None, last_error=f"{provider}: {reason}"[:1000])
    ctx.db.event(lid, "gen_pending", "gen_pending", f"{provider} failed: {reason}"[:300])
    ctx.db.error(f"worker.gen.{provider}", reason, listing_id=lid, code="provider_failed")


def _finish(ctx: Ctx, asset: dict, provider: str, glb: bytes, approx: bool, note: str) -> None:
    lid = asset["listing_id"]
    info = inspect_glb(glb)                      # raises ValueError on an invalid GLB
    # content hash in the name: a regenerated model gets a new URL, so the CDN never serves the previous one
    url = ctx.storage.put(f"glb/{lid}-raw-{provider}-{hashlib.sha1(glb).hexdigest()[:10]}.glb", glb, GLB_MIME)
    state = _state(asset)
    state.update(raw_glb_url=url, raw_info=info)
    state.pop("started_at", None)
    ctx.db.advance(lid, "gen_pending", "gen_done", f"{note} ({info['triangles']} tris, {info['bytes'] // 1024} KB)",
                   provider=provider, provider_job=None, glb_url=url, is_approx_model=approx, gen_state=state)


def use_generic(ctx: Ctx, asset: dict, why: str) -> None:
    lid = asset["listing_id"]
    cat = (ctx.db.one("select category from listing_details where listing_id=%s", (lid,)) or {}).get("category", "other")
    path = GENERIC_DIR / f"{cat}.glb"
    if not path.exists():
        ctx.db.fail(lid, "gen_pending", "worker.gen.generic", f"no generic model for category {cat}", permanent=True)
        return
    _finish(ctx, asset, "generic", path.read_bytes(), True, f"generic fallback: {why}")


def _poll_running(ctx: Ctx, by_name: dict[str, Provider]) -> tuple[int, dict[str, set[str]]]:
    """Poll every in-flight job once. Returns (finished count, busy key hashes per provider)."""
    db, s = ctx.db, ctx.settings
    rows = db.q("""select * from assets where status = 'gen_pending' and provider_job is not null
                   and (locked_by = %s or locked_at is null or locked_at < now() - make_interval(mins => %s))""",
                (WORKER_ID, s.lock_minutes))
    busy: dict[str, set[str]] = {}
    finished = 0
    for asset in rows:
        lid = asset["listing_id"]
        try:
            pname, kh, job = asset["provider_job"].split(":", 2)
        except ValueError:
            _provider_failed(ctx, asset, asset.get("provider") or "unknown", "corrupt provider_job")
            continue
        provider = by_name.get(pname)
        key = next((k for k in provider.keys if key_hash(k) == kh), None) if provider else None
        if provider is None or key is None:
            _provider_failed(ctx, asset, pname, "provider or key no longer configured")
            continue
        ledger = f"{pname}:{kh}"
        started = _state(asset).get("started_at")
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(started)).total_seconds() if started else 0
        try:
            res = provider.poll(job, key)
        except ProviderError as e:
            if e.quota:
                ctx.limits.cooldown(ledger, kind=e.quota_kind, retry_after=e.retry_after, note=str(e)[:200])
                _provider_failed(ctx, asset, pname, str(e))
            elif e.retryable and age < provider.timeout_s:
                busy.setdefault(pname, set()).add(kh)
                db.x("update assets set locked_by=%s, locked_at=now() where listing_id=%s", (WORKER_ID, lid))
            else:
                ctx.limits.failure(ledger)
                _provider_failed(ctx, asset, pname, str(e))
            continue
        except Exception as e:  # noqa: BLE001
            _provider_failed(ctx, asset, pname, f"poll crashed: {e!r}")
            continue
        if res.state == "done" and res.glb:
            try:
                _finish(ctx, asset, pname, res.glb, False, f"{pname} model generated")
                ctx.limits.success(ledger)
                finished += 1
            except ValueError as e:              # invalid GLB -> next provider
                ctx.limits.failure(ledger)
                _provider_failed(ctx, asset, pname, f"invalid GLB: {e}")
        elif res.state == "failed" and (res.error or "").startswith("job lost"):
            # in-process job (HF) lost to a worker restart: not the provider's fault, submit it again
            db.x("""update assets set provider = null, provider_job = null, locked_by = null, locked_at = null,
                    gen_state = coalesce(gen_state, '{}'::jsonb) - 'started_at', updated_at = now()
                    where listing_id = %s""", (lid,))
            db.event(lid, asset["status"], asset["status"], f"{pname} job lost in a worker restart: resubmitting")
        elif res.state == "failed":
            ctx.limits.failure(ledger)
            _provider_failed(ctx, asset, pname, res.error or "job failed")
        elif age > provider.timeout_s:
            # a 3D job that times out: mark it, move to the next provider (spec 14)
            ctx.limits.failure(ledger)
            _provider_failed(ctx, asset, pname, f"timed out after {int(age)}s")
        else:
            busy.setdefault(pname, set()).add(kh)
            db.x("update assets set locked_by=%s, locked_at=now() where listing_id=%s", (WORKER_ID, lid))
    return finished, busy


def _load_views(ctx: Ctx, asset: dict) -> list[View]:
    used = asset.get("views_used") or []
    views = []
    for v in used:
        try:
            views.append(View(ctx.storage.get(v["url"]), v.get("angle") or "front"))
        except Exception as e:  # noqa: BLE001
            log.info("listing %s: cutout view unavailable: %s", asset["listing_id"], e)
    if not views and asset.get("cutout_url"):
        views = [View(ctx.storage.get(asset["cutout_url"]), "front")]
    return views


def _start_one(ctx: Ctx, asset: dict, chain: list[Provider], busy: dict[str, set[str]]) -> str:
    """Returns 'started' | 'generic' | 'wait' | 'failed'."""
    db, lid = ctx.db, asset["listing_id"]
    state = _state(asset)
    tried = set(state.get("tried", []))
    # demo pins and sellers' own items (source 'FitCheck') always get real 3D
    pinned = bool((db.one("select demo_pin or source = 'FitCheck' as p from listings where id=%s", (lid,)) or {}).get("p"))
    policy = real_3d_policy()
    if policy == "none" or (policy == "pinned" and not pinned):
        use_generic(ctx, asset, "real 3D is reserved for demo-pinned listings")
        return "generic"
    try:
        views = _load_views(ctx, asset)
    except Exception as e:  # noqa: BLE001
        views = []
        db.error("worker.gen", f"cutout unavailable: {e}", listing_id=lid)
    if not views:
        db.fail(lid, "gen_pending", "worker.gen", "cutout image is missing", retry_to="queued",
                max_attempts=ctx.settings.max_attempts)
        return "failed"

    waiting = False
    for provider in chain:
        if provider.name in tried:
            continue
        for _ in range(len(provider.keys)):
            try:
                lease = provider.lease(ctx.limits, busy.get(provider.name))
            except QuotaExceeded as e:
                if e.reason == "busy":
                    waiting = True                # a key exists but is running its 1 allowed job
                break
            use = views if (provider.supports_multi and len(views) >= 2) else views[:1]
            try:
                job = ctx.limits.with_retry(lambda: provider.submit(use, lease.key), pname=lease.provider, tries=3)
            except ProviderError as e:
                if e.quota:                       # cool this key down and try the next key
                    ctx.limits.cooldown(lease.provider, kind=e.quota_kind, retry_after=e.retry_after, note=str(e)[:200])
                    db.error(f"worker.gen.{provider.name}", str(e), listing_id=lid, code="quota")
                    continue
                db.error(f"worker.gen.{provider.name}", str(e), listing_id=lid, code="submit_failed")
                tried.add(provider.name)
                break
            except Exception as e:  # noqa: BLE001
                db.error(f"worker.gen.{provider.name}", f"submit crashed: {e!r}", listing_id=lid, code="unexpected")
                tried.add(provider.name)
                break
            kh = key_hash(lease.key)
            busy.setdefault(provider.name, set()).add(kh)
            state.update(tried=sorted(tried), started_at=datetime.now(timezone.utc).isoformat(),
                         multi=len(use) > 1)
            _save_state(ctx, lid, state, provider=provider.name, provider_job=f"{provider.name}:{kh}:{job}",
                        locked_by=WORKER_ID, locked_at=datetime.now(timezone.utc))
            db.event(lid, "gen_pending", "gen_pending",
                     f"{provider.name} job started ({len(use)} photo{'s' if len(use) > 1 else ''})")
            return "started"
        if waiting:
            break                                 # prefer waiting for a better provider over falling down the chain
    if waiting:
        state["tried"] = sorted(tried)
        _save_state(ctx, lid, state, locked_by=None, locked_at=None)
        return "wait"
    asset["gen_state"] = {**state, "tried": sorted(tried)}
    use_generic(ctx, asset, "all providers failed or are out of quota")
    return "generic"


def run(ctx: Ctx, batch: int = 4) -> int:
    db, s = ctx.db, ctx.settings
    chain = ctx.providers
    by_name = {p.name: p for p in chain}
    done, busy = _poll_running(ctx, by_name)
    for _ in range(batch):
        if ctx.stop.is_set():
            break
        asset = db.claim("gen_pending", "gen_pending", lock_minutes=s.lock_minutes, count_attempt=False,
                         extra_where="and a.provider_job is null")
        if not asset:
            break
        try:
            outcome = _start_one(ctx, asset, chain, busy)
        except ValueError as e:                   # invalid generic GLB etc.
            db.fail(asset["listing_id"], "gen_pending", "worker.gen", str(e), permanent=True)
            continue
        except Exception as e:  # noqa: BLE001
            db.fail(asset["listing_id"], "gen_pending", "worker.gen", f"unexpected: {e!r}", retry_to="gen_pending",
                    max_attempts=s.max_attempts + 2)
            continue
        if outcome in ("generic",):
            done += 1
        if outcome == "wait":
            break
    return done
