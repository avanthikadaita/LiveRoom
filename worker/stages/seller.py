"""Stage: seller (spec 11.2). A seller's photo + measured height -> a true-scale 3D listing + fair price.

The web app uploads the photo to Blob and inserts a `seller_drafts` row (status 'new'). This stage:
  1. creates an inactive listing (source 'FitCheck') for it, so the normal cutout -> 3D -> export pipeline runs
  2. tags it with Gemini (category, style, proportions). The seller's measured height is the true height;
     width and depth keep the tagger's proportions, scaled to that height. If Gemini is out of quota the
     category comes from the title, so a seller is never stuck.
  3. suggests a fair price: median (and 25th-75th percentile range) of active scraped listings in the same
     category, preferring ones of a similar height. Free items are left out. Under 3 comparables: no suggestion.
  4. queues the asset. Seller items always get real 3D (like demo pins), ahead of everything else.
Each loop also moves drafts to 'ready' / 'failed' when their asset finishes, so the web page only polls the draft.
Publishing (listings.is_active = true) is the web app's job, after the seller confirms.
"""
from __future__ import annotations

import logging
import re

from ..config import CATEGORY_ALLOWLIST
from ..context import Ctx
from ..db import jsonb
from ..geo import lookup
from ..limits import ProviderError, QuotaExceeded
from ..orient import priors
from .tag import embed_missing, tag_one

log = logging.getLogger("worker.seller")

CLAIM = """
update seller_drafts set status = 'processing', updated_at = now()
where id = (select id from seller_drafts where status = 'new' order by created_at limit 1 for update skip locked)
returning *
"""
KEYWORDS = [  # title words -> category, checked in order (most specific first)
    ("desk_lamp", r"desk lamp|table lamp|reading lamp"), ("floor_lamp", r"floor lamp|standing lamp|torchiere"),
    ("nightstand", r"night ?stand|bedside"), ("coffee_table", r"coffee table"), ("side_table", r"side table|end table|accent table"),
    ("dining_chair", r"dining chair|kitchen chair"), ("accent_chair", r"armchair|accent chair|lounge chair|chair"),
    ("bookshelf", r"book ?shel|book ?case|shelf|shelving"), ("dresser", r"dresser|chest of drawers|drawers"),
    ("ottoman", r"ottoman|pouf|footstool"), ("stool", r"stool"), ("desk", r"desk"), ("desk_lamp", r"lamp"),
]


def guess_category(text: str) -> str:
    low = (text or "").lower()
    for cat, rx in KEYWORDS:
        if re.search(rx, low):
            return cat
    return "other"


# Sets of 2-6 ("set of 4 bar stools") and table-and-chairs bundles are priced for the whole set and would
# inflate a one-item suggestion.
SET_TITLE = (r"(set of|pair of|\m(2|3|4|5|6|two|three|four|five|six)\s*(x\s*)?(pc|pcs|pieces|stools|chairs|tables|nightstands|lamps)\M"
             r"|\mset\M|table\M.*\mchairs|chairs\M.*\mtable)")
# Too few comps in a category (fewer than WIDEN_BELOW): borrow from the closest categories
WIDEN_BELOW = 5
RELATED = {
    "dining_chair": ["accent_chair", "stool"], "accent_chair": ["dining_chair"], "stool": ["dining_chair", "ottoman"],
    "ottoman": ["stool"], "side_table": ["nightstand"], "nightstand": ["side_table"], "coffee_table": ["side_table"],
    "desk_lamp": ["floor_lamp"], "floor_lamp": ["desk_lamp"], "desk": ["side_table"], "bookshelf": ["dresser"],
    "dresser": ["nightstand"],
}


def _q(prices: list[float], p: float) -> float:
    """Linear-interpolated quantile of a sorted list (same as Postgres percentile_cont)."""
    i = p * (len(prices) - 1)
    lo, hi = int(i), min(int(i) + 1, len(prices) - 1)
    return prices[lo] + (prices[hi] - prices[lo]) * (i - lo)


def _round5(v: float) -> int:
    return max(5, int(5 * round(v / 5)))


def fair_price(ctx: Ctx, category: str, height_in: float) -> dict:
    """Price that sells within a few days: local second-hand comps only (Craigslist + Marketplace, no eBay, which
    is mostly new or shipped stock), single items only, a bit under the middle of the market.
    fair_price = 40th percentile, low = 25th ("quick sale"), high = median ("typical")."""
    def comps(cats: list[str]) -> list[dict]:
        return ctx.db.q("""select l.url, l.price_usd::float as price, d.h_in::float as h
                           from listings l join listing_details d on d.listing_id = l.id
                           where l.is_active and l.source in ('craigslist', 'fb_marketplace') and d.category = any(%s)
                             and l.price_usd > 0 and l.title !~* %s""", (cats, SET_TITLE))
    rows = comps([category])
    if len(rows) < WIDEN_BELOW and RELATED.get(category):
        rows = comps([category, *RELATED[category]])
    if height_in:
        similar = [r for r in rows if r["h"] and abs(r["h"] - height_in) <= 0.4 * height_in]
        if len(similar) >= 3:
            rows = similar
    prices = sorted(r["price"] for r in rows)
    if len(prices) < 3:
        return {"fair_price_usd": None, "fair_low_usd": None, "fair_high_usd": None, "comps_n": len(prices), "comp_urls": []}
    fair, low, high = _round5(_q(prices, 0.4)), _round5(_q(prices, 0.25)), _round5(_q(prices, 0.5))
    rows.sort(key=lambda r: abs(r["price"] - fair))
    return {"fair_price_usd": fair, "fair_low_usd": min(low, fair), "fair_high_usd": max(high, fair),
            "comps_n": len(prices), "comp_urls": [r["url"] for r in rows[:5]]}


def start_draft(ctx: Ctx, d: dict) -> None:
    db, s = ctx.db, ctx.settings
    height = float(d["height_in"])
    lat, lng, city = d.get("lat"), d.get("lng"), d.get("city")
    if (lat is None or lng is None) and city:
        place = lookup(city)
        if place:
            lat, lng = place["lat"], place["lng"]
    title = (d.get("title") or "").strip() or "Item for sale"
    lst = db.one("""insert into listings (source, external_id, url, title, price_usd, ships, city, lat, lng, photo_urls,
                                          raw, is_active, posted_at)
                    values ('FitCheck', %(ext)s, %(url)s, %(title)s, %(price)s, false, %(city)s, %(lat)s, %(lng)s,
                            array[%(photo)s], %(raw)s, false, now())
                    on conflict (source, external_id) do update set photo_urls = excluded.photo_urls, title = excluded.title
                    returning *""",
                 {"ext": f"draft-{d['id']}", "url": f"{(s.site_url or '').rstrip('/')}/sell/{d['id']}", "title": title,
                  "price": d.get("ask_usd"), "city": city, "lat": lat, "lng": lng, "photo": d["photo_url"],
                  "raw": jsonb({"seller_draft": d["id"]})})
    lid = lst["id"]

    tagged = False
    if s.gemini_keys:
        try:
            tagged = tag_one(ctx, lst)
        except (QuotaExceeded, ProviderError) as e:
            log.info("seller draft %s: Gemini unavailable (%s), using the title", d["id"], e)
    det = db.one("select * from listing_details where listing_id = %s", (lid,))
    if not tagged or not det or (det["model_used"] or "").startswith("none:"):
        cat = guess_category(title)
        db.x("""insert into listing_details (listing_id, category, dims_source, photo_ok, eligible_3d, summary, model_used)
                values (%s, %s, 'estimated', true, true, %s, 'seller:title')
                on conflict (listing_id) do update set category = excluded.category, model_used = excluded.model_used""",
             (lid, cat if cat in CATEGORY_ALLOWLIST else "other", title[:200]))
        det = db.one("select * from listing_details where listing_id = %s", (lid,))

    # the seller's own pick of category (from the /sell form) beats the tagger and the title guess
    chosen = d.get("category")
    if chosen in CATEGORY_ALLOWLIST and chosen != det["category"]:
        pw, pd, ph = priors().get(chosen, priors()["other"])
        db.x("update listing_details set category = %s, w_in = %s, d_in = %s, h_in = %s where listing_id = %s",
             (chosen, pw, pd, ph, lid))
        det = db.one("select * from listing_details where listing_id = %s", (lid,))

    # the seller's height is the truth; keep the tagger's proportions for width and depth
    w, dd, h = (float(det[k]) if det[k] is not None else None for k in ("w_in", "d_in", "h_in"))
    k = height / h if h else None
    db.x("""update listing_details set h_in = %s, w_in = %s, d_in = %s, dims_source = 'estimated', dims_from_text = false,
            eligible_3d = true, photo_ok = true where listing_id = %s""",
         (height, round(w * k, 1) if (w and k) else None, round(dd * k, 1) if (dd and k) else None, lid))
    try:
        embed_missing(ctx, limit=3)
    except Exception as e:  # noqa: BLE001 - search can embed it later
        log.info("seller draft %s: embedding skipped: %s", d["id"], e)

    price = fair_price(ctx, det["category"], height)
    db.x("""insert into assets (listing_id, status, updated_at) values (%s, 'queued', now() - interval '1 day')
            on conflict (listing_id) do nothing""", (lid,))
    db.event(lid, None, "queued", "seller draft: real 3D requested")
    db.x("""update seller_drafts set listing_id = %(lid)s, category = %(cat)s, fair_price_usd = %(fair_price_usd)s,
            fair_low_usd = %(fair_low_usd)s, fair_high_usd = %(fair_high_usd)s, comps_n = %(comps_n)s,
            comp_urls = %(comp_urls)s, error = null, updated_at = now() where id = %(id)s""",
         {**price, "lid": lid, "cat": det["category"], "id": d["id"]})
    log.info("seller draft %s -> listing %s (%s, fair ~$%s from %s comps)", d["id"], lid, det["category"],
             price["fair_price_usd"], price["comps_n"])


SYNC = """
update seller_drafts sd set
  status = case when a.status in ('ready', 'fallback_ready') then 'ready' else 'failed' end,
  error = case when a.status = 'failed' then a.last_error end, updated_at = now()
from assets a
where a.listing_id = sd.listing_id and sd.status = 'processing' and a.status in ('ready', 'fallback_ready', 'failed')
returning sd.id, sd.status
"""


def run(ctx: Ctx, batch: int = 2) -> int:
    db = ctx.db
    done = 0
    for _ in range(batch):
        if ctx.stop.is_set():
            break
        d = db.one(CLAIM)
        if not d:
            break
        try:
            start_draft(ctx, d)
            done += 1
        except Exception as e:  # noqa: BLE001
            db.x("update seller_drafts set status = 'failed', error = %s, updated_at = now() where id = %s",
                 (f"could not start: {e}"[:500], d["id"]))
            db.error("worker.seller", f"draft {d['id']}: {e!r}", code="seller_failed")
    for r in db.q(SYNC):
        log.info("seller draft %s %s", r["id"], r["status"])
        done += 1
    return done
