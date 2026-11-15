"""FitCheck worker.

    python -m worker.run --loop        # all stages; --stages a,b to pick

Each stage processes a small batch and returns, so a stalled provider never blocks the others.
All job state lives in Neon. Ctrl-C finishes the current item and releases locks.
"""
from __future__ import annotations

import argparse
import logging
import signal
import sys
import time

from .context import Ctx
from .db import WORKER_ID
from .limits import QuotaExceeded
from .stages import cutout, export, gen, scrape, select, seller, sets, tag, verify

STAGES = {
    "scrape": scrape.run, "tag": tag.run, "select": select.run, "cutout": cutout.run,
    "gen": gen.run, "export": export.run, "verify": verify.run,
    "seller": seller.run, "sets": sets.run,
}
DEFAULT = "seller,scrape,tag,select,cutout,gen,export,sets"
log = logging.getLogger("worker")


def run_once(ctx: Ctx, stages: list[str]) -> dict[str, int]:
    out: dict[str, int] = {}
    for name in stages:
        if ctx.stop.is_set():
            break
        t0 = time.monotonic()
        try:
            out[name] = STAGES[name](ctx) or 0
        except QuotaExceeded as e:
            log.info("%s paused: %s", name, e)
            out[name] = 0
        except Exception as e:  # noqa: BLE001 - a stage must never take the worker down
            out[name] = 0
            try:
                ctx.db.error(f"worker.{name}", f"stage crashed: {e!r}", code="stage_crash")
            except Exception:  # noqa: BLE001
                log.exception("stage %s crashed and the database is unreachable", name)
        dt = time.monotonic() - t0
        if out.get(name) or dt > 5:
            log.info("stage %-8s processed=%d in %.1fs", name, out.get(name, 0), dt)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stages", default=DEFAULT, help=f"comma separated, from: {', '.join(STAGES)}")
    ap.add_argument("--loop", action="store_true", help="keep running until Ctrl-C")
    ap.add_argument("--interval", type=float, default=5.0, help="seconds between loops (idle loops back off to 20 s)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s", datefmt="%H:%M:%S")
    for noisy in ("httpx", "httpcore", "google_genai", "PIL", "asyncio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    stages = [s.strip() for s in args.stages.split(",") if s.strip()]
    unknown = [s for s in stages if s not in STAGES]
    if unknown:
        ap.error(f"unknown stage(s): {', '.join(unknown)}")

    ctx = Ctx()

    def _stop(signum, _frame):  # noqa: ANN001
        if ctx.stop.is_set():
            log.warning("second interrupt: exiting now")
            raise SystemExit(130)
        log.info("stopping after the current item (Ctrl-C again to force)")
        ctx.stop.set()

    signal.signal(signal.SIGINT, _stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _stop)

    log.info("worker %s starting, stages: %s, storage: %s", WORKER_ID, ",".join(stages),
             "Vercel Blob" if ctx.storage.hosted else "LOCAL FOLDER (dev only: set BLOB_READ_WRITE_TOKEN)")
    try:
        ctx.db.one("select 1 as ok")
    except Exception as e:  # noqa: BLE001
        log.error("cannot reach the database: %s", e)
        return 2
    try:
        while True:
            out = run_once(ctx, stages)
            if not args.loop or ctx.stop.is_set():
                break
            ctx.stop.wait(args.interval if any(out.values()) else max(args.interval, 20.0))
    finally:
        try:
            released = ctx.db.release_locks()
            log.info("released %d lock(s), bye", released)
        except Exception as e:  # noqa: BLE001
            log.warning("could not release locks: %s", e)
        ctx.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
