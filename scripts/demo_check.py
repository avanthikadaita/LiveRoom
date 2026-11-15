"""Pre-judging check (spec section 9). Prints PASS or FAIL per line and warms Neon. Exit code 1 on any FAIL.

    python -m scripts.demo_check
    python -m scripts.demo_check --site https://FitCheck.example --min-pinned 8

Web checks assume the routes in spec section 7: POST /api/tts {text} -> audio bytes,
POST /api/stt (multipart field "audio") -> {text}, POST /api/search {text} -> {results: [...]} (web/lib/search/schema.ts).
"""
from __future__ import annotations

import argparse
import sys
import time

import httpx

from worker.config import get_settings
from worker.db import connect

DEMO_QUERIES = [
    "desk lamp and side table under $40, warm wood, close to campus",
    "nightstand under 30 dollars near Pepper Canyon",
    "desk lamp that ships, I don't have a car",
]
USDZ_MIME = "model/vnd.usdz+zip"
results: list[tuple[bool, str]] = []


def line(ok: bool | None, msg: str) -> bool:
    tag = "PASS" if ok else ("SKIP" if ok is None else "FAIL")
    print(f"{tag}  {msg}")
    if ok is not None:
        results.append((ok, msg))
    return bool(ok)


def check_db(name: str, url: str) -> object | None:
    if not url:
        line(False, f"{name} database: connection string not set")
        return None
    try:
        t0 = time.monotonic()
        conn = connect(url)
        conn.execute("select 1").fetchone()
        cold = time.monotonic() - t0
        t0 = time.monotonic()
        conn.execute("select 1").fetchone()          # second query: this is what a judge will feel
        line(True, f"{name} database reachable (first query {cold * 1000:.0f} ms, warm {1000 * (time.monotonic() - t0):.0f} ms)")
        return conn
    except Exception as e:  # noqa: BLE001
        line(False, f"{name} database unreachable: {str(e)[:120]}")
        return None


def check_items(conn, min_pinned: int, client: httpx.Client) -> None:
    rows = conn.execute("""
        select l.id, l.title, l.is_active, l.external_id, a.status::text as status, a.usdz_url, a.glb_url,
               a.is_approx_model, a.provider
        from listings l join assets a on a.listing_id = l.id
        where l.demo_pin order by l.id""").fetchall()
    real = [r for r in rows if r["status"] == "ready" and not r["is_approx_model"] and r["is_active"]]
    line(len(real) >= min_pinned, f"{len(real)} demo_pin items ready with real models (need {min_pinned}); "
                                  f"{len(rows) - len(real)} pinned items are not ready/real")
    fixtures = conn.execute("select count(*) n from listings where external_id like 'fixture-%'").fetchone()["n"]
    line(fixtures == 0, f"{fixtures} fake fixture listings in this branch (must be 0: run scripts.drop_fixtures)")
    bad = 0
    for r in real:
        url = r["usdz_url"] or ""
        if not url.startswith("https://"):
            bad += 1
            line(False, f"item {r['id']}: USDZ is not a hosted https URL ({url[:40]}): AR Quick Look needs one")
            continue
        try:
            resp = client.head(url, follow_redirects=True)
            if resp.status_code == 405:
                resp = client.get(url, headers={"range": "bytes=0-0"}, follow_redirects=True)
            ctype = resp.headers.get("content-type", "").split(";")[0].strip()
            ok = resp.status_code in (200, 206) and ctype == USDZ_MIME
            if not ok:
                bad += 1
                line(False, f"item {r['id']}: USDZ returned {resp.status_code} with content-type '{ctype}'")
        except httpx.HTTPError as e:
            bad += 1
            line(False, f"item {r['id']}: USDZ not reachable: {e}")
    if real:
        line(bad == 0, f"{len(real) - bad}/{len(real)} demo USDZ URLs return 200 with {USDZ_MIME}")
    stats = conn.execute("""select count(*) filter (where a.status = 'ready') ready,
                                   count(*) filter (where a.status = 'fallback_ready') fallback,
                                   count(*) filter (where a.status = 'failed') failed,
                                   (select count(*) from listings where is_active) listings,
                                   (select count(*) from listing_details where embedding is not null) embedded,
                                   (select count(*) from listings where is_active and ships) ships,
                                   (select count(*) from listings where is_active and lat is not null) local
                            from assets a""").fetchone()
    line(stats["local"] > 0 and stats["ships"] > 0,
         f"{stats['local']} local pickup listings with a location, {stats['ships']} that ship (need both for the demo)")
    print(f"      info: {stats['listings']} active listings, {stats['embedded']} embedded, {stats['ready']} ready, "
          f"{stats['fallback']} approx-model, {stats['failed']} failed")


def check_web(site: str, client: httpx.Client) -> None:
    site = site.rstrip("/")
    try:
        r = client.get(f"{site}/api/health")
        line(r.status_code == 200, f"/api/health -> {r.status_code}")
    except httpx.HTTPError as e:
        line(False, f"/api/health unreachable: {e}")
        return
    # TTS -> STT round trip
    audio = None
    try:
        r = client.post(f"{site}/api/tts", json={"text": "Found three lamps under thirty dollars."})
        audio = r.content if r.status_code == 200 and len(r.content) > 1000 else None
        line(audio is not None, f"/api/tts -> {r.status_code}, {len(r.content)} bytes of {r.headers.get('content-type', '?')}")
    except httpx.HTTPError as e:
        line(False, f"/api/tts failed: {e}")
    if audio:
        try:
            r = client.post(f"{site}/api/stt", files={"audio": ("check.mp3", audio, "audio/mpeg")})
            text = (r.json().get("text") or "") if r.status_code == 200 else ""
            line("lamp" in text.lower(), f"/api/stt round trip -> {r.status_code}, heard: '{text[:60]}'")
        except (httpx.HTTPError, ValueError) as e:
            line(False, f"/api/stt failed: {e}")
    for q in DEMO_QUERIES:
        try:
            client.post(f"{site}/api/search", json={"text": q})      # warm (cache, cold start)
            t0 = time.monotonic()
            r = client.post(f"{site}/api/search", json={"text": q})
            dt = time.monotonic() - t0
            n = len((r.json().get("results") or [])) if r.status_code == 200 else 0
            line(r.status_code == 200 and n > 0 and dt < 3.0, f"/api/search '{q[:38]}...' -> {n} results in {dt:.2f} s")
        except (httpx.HTTPError, ValueError) as e:
            line(False, f"/api/search '{q[:38]}...' failed: {e}")


def main() -> int:
    s = get_settings()
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default=s.site_url)
    ap.add_argument("--min-pinned", type=int, default=8)
    a = ap.parse_args()
    client = httpx.Client(timeout=httpx.Timeout(30, connect=10), follow_redirects=True)  # /api/tts redirects to cached audio in Blob

    main_conn = check_db("main", s.database_url)
    demo_conn = check_db("demo", s.database_url_demo)
    target = demo_conn or main_conn
    if target is not None:
        if demo_conn is None:
            print("      (checking demo items on main because the demo branch is not reachable)")
        try:
            check_items(target, a.min_pinned, client)
        except Exception as e:  # noqa: BLE001
            line(False, f"item checks crashed: {str(e)[:160]}")
    if a.site:
        check_web(a.site, client)
    else:
        line(None, "web checks (/api/health, /api/stt, /api/tts, /api/search): set SITE_URL or pass --site")
    failed = [m for ok, m in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed" + ("" if not failed else " - NOT READY"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
