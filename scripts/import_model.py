"""Attach a hand-made 3D model (GLB exported from the Tripo / Meshy websites) to a real listing.

    python -m scripts.import_model --url https://www.facebook.com/marketplace/item/1234567890/ --glb chair.glb
    python -m scripts.import_model --id 42 --glb chair.glb
    python -m scripts.import_model --csv models.csv          # columns: url (or id), glb, [orient]
    options: --orient x+90   --no-pin   --max-tris 80000   --no-export

What it does, per model:
  1. finds the listing in Neon by URL or id. A Marketplace or eBay URL that is not in the database yet is
     fetched through Bright Data (1-3 min) and tagged by Gemini, exactly like the worker would.
  2. shrinks the GLB (website exports are ~2M triangles / 4K textures; phones want <= 80k (the USDZ stores geometry uncompressed) <= 15 MB)
  3. uploads it as the listing's raw model (provider 'manual', a real model, not approx) and pins the listing
  4. runs the normal export right away: auto-orient, scale to the listing's dimensions, USDZ + GLB, validation
  5. prints the USDZ URL and writes a preview PNG to previews/ so a human can check it is upright

If the preview is sideways or upside down: `python -m scripts.curate orient <id> <orientation>`.
"""
from __future__ import annotations

import argparse
import csv
import re
import sys
import time
from pathlib import Path

from worker.context import Ctx
from worker.db import jsonb
from worker.glbtools import inspect_glb
from worker.normalize import Skip
from worker.orient import ORIENTATIONS
from worker.shrink import ShrinkError, shrink_glb
from worker.stages.export import InvalidModel, export_one
from worker.stages.scrape import ingest
from worker.stages.tag import embed_missing, tag_one
from worker.storage import GLB_MIME

URL_PATTERNS = [
    ("fb_marketplace", re.compile(r"facebook\.com/marketplace/item/(\d+)")),
    ("ebay", re.compile(r"ebay\.[a-z.]+/itm/(?:[^/]+/)?(\d+)")),
    ("craigslist", re.compile(r"craigslist\.org/(?:.*?/(\d{8,})\.html|view/d/[^/?#]+/([A-Za-z0-9]{8,}))")),
]


class ImportFailed(Exception):
    pass


def parse_url(url: str) -> tuple[str, str]:
    for source, rx in URL_PATTERNS:
        m = rx.search(url)
        if m:
            return source, next(g for g in m.groups() if g)
    raise ImportFailed(f"not a Marketplace item, eBay item or Craigslist post URL: {url}")


def fetch_listing(ctx: Ctx, source: str, url: str) -> None:
    """Collect one item page through Bright Data and upsert it (same normalizer as the worker)."""
    s = ctx.settings
    if source == "craigslist":
        from worker.normalize import parse_craigslist_post
        print("  fetching the post through Bright Data Web Unlocker...", flush=True)
        rec = parse_craigslist_post(ctx.bd.unlock(url), url.split("?")[0])
        if not rec:
            raise ImportFailed(f"could not read the Craigslist post at {url} (removed, or the page layout changed)")
        stats = ingest(ctx, "craigslist", [rec], cap=5)
        if not (stats["inserted"] or stats["updated"]):
            raise ImportFailed(f"the post was skipped by the normalizer ({stats})")
        return
    dataset = {"fb_marketplace": s.bd_fb, "ebay": s.bd_ebay}.get(source)
    if not dataset:
        raise ImportFailed(f"{source} listings cannot be fetched automatically yet: run the worker's scrape first, "
                           "or use --id with a listing that is already in the database")
    print(f"  fetching the listing through Bright Data (usually 1-3 min)...", flush=True)
    sid = ctx.bd.trigger(dataset, [{"url": url}])
    t0 = time.monotonic()
    while True:
        status = ctx.bd.progress(sid).get("status")
        if status == "ready":
            break
        if status == "failed" or time.monotonic() - t0 > 600:
            raise ImportFailed(f"Bright Data job {sid} ended with status {status}")
        time.sleep(10)
    records = []
    for _ in range(6):                       # the snapshot can take a few seconds after 'ready'
        try:
            records = ctx.bd.download(sid)
            break
        except Exception:  # noqa: BLE001
            time.sleep(10)
    if not records or all(r.get("error") for r in records):
        reason = records[0].get("error") if records else "no records"
        raise ImportFailed(f"Bright Data returned nothing usable for {url}: {reason}")
    stats = ingest(ctx, source, records, cap=5)
    if not (stats["inserted"] or stats["updated"]):
        raise ImportFailed(f"the listing was skipped by the normalizer ({stats}); "
                           "eBay items far away with no shipping price are skipped on purpose")


def resolve_listing(ctx: Ctx, url: str | None, lid: int | None) -> dict:
    db = ctx.db
    if lid is not None:
        row = db.one("select * from listings where id = %s", (lid,))
        if not row:
            raise ImportFailed(f"no listing with id {lid}")
        return row
    assert url
    source, ext = parse_url(url)
    row = db.one("select * from listings where source = %s and external_id = %s", (source, ext))
    if not row:
        fetch_listing(ctx, source, url)
        row = db.one("select * from listings where source = %s and external_id = %s", (source, ext))
        if not row:
            raise ImportFailed("fetched, but the listing id in the result does not match the URL")
    return row


def ensure_details(ctx: Ctx, listing: dict) -> None:
    db = ctx.db
    d = db.one("select listing_id, model_used from listing_details where listing_id = %s", (listing["id"],))
    if not d or (d["model_used"] or "").startswith("none:"):
        print("  tagging with Gemini (category, dimensions, style)...", flush=True)
        if d:
            db.x("delete from listing_details where listing_id = %s", (listing["id"],))
        if not tag_one(ctx, listing):
            print("  ! tagging failed (photo unavailable); the model is scaled with category defaults")
    embed_missing(ctx, limit=5)
    # a human-made model exists, so this listing gets an AR button regardless of the photo verdict
    db.x("update listing_details set eligible_3d = true where listing_id = %s", (listing["id"],))


def import_one(ctx: Ctx, glb_path: Path, url: str | None = None, lid: int | None = None, orient: str | None = None,
               pin: bool = True, max_tris: int = 80_000, export: bool = True) -> dict:
    db = ctx.db
    if not glb_path.exists():
        raise ImportFailed(f"file not found: {glb_path}")
    raw = glb_path.read_bytes()
    if raw[:4] != b"glTF":
        raise ImportFailed(f"{glb_path.name} is not a binary GLB (export as GLB, not GLTF/OBJ/FBX/USDZ)")
    listing = resolve_listing(ctx, url, lid)
    lid = listing["id"]
    print(f"  listing #{lid}: {listing['title'][:70]} (${listing['price_usd']}, {listing['source']})")
    ensure_details(ctx, listing)

    before = inspect_glb(raw)
    try:
        glb, stats = shrink_glb(raw, max_tris=max_tris)
    except ShrinkError as e:
        raise ImportFailed(f"could not process the GLB: {e}") from e
    info = inspect_glb(glb)
    print(f"  model: {before['triangles']:,} tris / {len(raw) / 1e6:.1f} MB -> {info['triangles']:,} tris / "
          f"{len(glb) / 1e6:.1f} MB, {info['textures']} texture(s)")
    if stats["triangles_after"] > max_tris * 1.5:
        print("  ! could not get under the triangle budget (many UV seams); the export may be slow on phones")

    url_raw = ctx.storage.put(f"glb/{lid}-raw-manual-{int(time.time())}.glb", glb, GLB_MIME)
    state = {"raw_glb_url": url_raw, "raw_info": info,
             "manual": {"file": glb_path.name, "triangles_in": before["triangles"], "bytes_in": len(raw)}}
    db.x("""insert into assets (listing_id, status, provider, glb_url, is_approx_model, gen_state, attempts,
                                orient_override, locked_by, locked_at, updated_at)
            values (%(id)s, 'exporting', 'manual', %(glb)s, false, %(gs)s, 0, %(o)s, 'import_model', now(), now())
            on conflict (listing_id) do update set status = 'exporting', provider = 'manual', provider_job = null,
              glb_url = excluded.glb_url, is_approx_model = false, gen_state = excluded.gen_state, attempts = 0,
              orient_override = excluded.orient_override, yaw_override_deg = null, last_error = null,
              next_attempt_at = null, locked_by = 'import_model', locked_at = now(), updated_at = now()""",
         {"id": lid, "glb": url_raw, "gs": jsonb(state), "o": orient})
    db.event(lid, None, "exporting", f"hand-made model imported from {glb_path.name} ({info['triangles']} tris)")
    if pin:
        db.x("update listings set demo_pin = true where id = %s", (lid,))

    # keep our own copy of the main photo: marketplace CDN links expire within days
    photos = listing["photo_urls"] or []
    if ctx.storage.hosted and photos and "blob.vercel-storage.com" not in photos[0]:
        try:
            from worker.storage import fetch_bytes
            mirror = ctx.storage.put(f"photo/{lid}-0.jpg", fetch_bytes(photos[0], timeout=30), "image/jpeg")
            db.x("update listings set photo_urls[1] = %s where id = %s", (mirror, lid))
        except Exception as e:  # noqa: BLE001
            print(f"  ! photo mirror failed (the card may lose its photo when the link expires): {e}")

    if not export:
        db.x("update assets set status = 'gen_done', locked_by = null, locked_at = null where listing_id = %s", (lid,))
        print("  queued for export (the worker's export stage picks it up)")
        return {"id": lid}
    asset = db.one("select * from assets where listing_id = %s", (lid,))
    try:
        export_one(ctx, asset)
    except InvalidModel as e:
        db.fail(lid, "exporting", "import_model", f"manual model rejected: {e}", permanent=True)
        raise ImportFailed(f"export rejected the model: {e}") from e
    a = db.one("""select usdz_url, glb_url, final_w_in, final_d_in, final_h_in, orientation_used, file_bytes
                  from assets where listing_id = %s""", (lid,))
    d = db.one("select w_in, d_in, h_in, dims_source from listing_details where listing_id = %s", (lid,))
    print(f"  READY: {a['final_w_in']} x {a['final_d_in']} x {a['final_h_in']} in "
          f"(listing says {d['w_in']} x {d['d_in']} x {d['h_in']}, {d['dims_source']}), "
          f"orientation {a['orientation_used']}, USDZ {a['file_bytes'] // 1024} KB")
    print(f"  USDZ: {a['usdz_url']}")
    try:
        out = Path("previews")
        out.mkdir(exist_ok=True)
        png = out / f"import-{lid}.png"
        png.write_bytes(ctx.exporter.render_png(ctx.storage.get(a["glb_url"])))
        print(f"  preview: {png.resolve()}  (check it is upright and facing forward)")
    except Exception as e:  # noqa: BLE001
        print(f"  ! preview failed: {e}")
    if ctx.settings.site_url:
        print(f"  page: {ctx.settings.site_url.rstrip('/')}/item/{lid}")
    if not ctx.storage.hosted:
        print("  ! stored locally (no BLOB_READ_WRITE_TOKEN): phones cannot open this until it is re-run with Blob")
    return {"id": lid, **a}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--url")
    g.add_argument("--id", type=int)
    g.add_argument("--csv", help="columns: url or id, glb, optional orient")
    ap.add_argument("--glb", type=Path)
    ap.add_argument("--orient", choices=ORIENTATIONS)
    ap.add_argument("--no-pin", action="store_true")
    ap.add_argument("--no-export", action="store_true")
    ap.add_argument("--max-tris", type=int, default=80_000)
    a = ap.parse_args()
    if not a.csv and not a.glb:
        ap.error("--glb is required with --url / --id")

    jobs: list[dict] = []
    if a.csv:
        base = Path(a.csv).resolve().parent
        with open(a.csv, newline="", encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                glb = Path(row["glb"].strip())
                jobs.append({"url": (row.get("url") or "").strip() or None,
                             "lid": int(row["id"]) if (row.get("id") or "").strip() else None,
                             "glb": glb if glb.is_absolute() else base / glb,
                             "orient": (row.get("orient") or "").strip() or None})
    else:
        jobs.append({"url": a.url, "lid": a.id, "glb": a.glb, "orient": a.orient})

    ctx = Ctx()
    ok = 0
    try:
        for j in jobs:
            print(f"\n{j['glb'].name} -> {j['url'] or ('#' + str(j['lid']))}")
            try:
                import_one(ctx, j["glb"], url=j["url"], lid=j["lid"], orient=j["orient"], pin=not a.no_pin,
                           max_tris=a.max_tris, export=not a.no_export)
                ok += 1
            except (ImportFailed, Skip) as e:
                print(f"  FAILED: {e}")
    finally:
        ctx.close()
    print(f"\n{ok}/{len(jobs)} imported")
    return 0 if ok == len(jobs) else 1


if __name__ == "__main__":
    sys.exit(main())
