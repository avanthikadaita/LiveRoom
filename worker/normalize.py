"""Bright Data record -> listings row, per source (spec 6.1).

Privacy: never store seller names, phone numbers or emails. Seller/profile fields are dropped from
`raw`, and phone numbers / emails are scrubbed out of free text before anything is stored.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urljoin, urlparse

from . import geo

# keys that identify a person or a seller account
PII_KEYS = re.compile(r"(seller|profile|owner|user|phone|email|contact|store_name|payment)", re.I)
KEEP_KEYS = {"seller_description", "description_from_the_seller", "description_from_the_seller_parsed"}
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
PHONE_RE = re.compile(r"(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)")
MAX_PHOTOS = 6


class Skip(Exception):
    """Record is not a usable listing (sold, error row, no id, no photo)."""


def scrub_text(s: str | None) -> str | None:
    if not s:
        return s
    s = EMAIL_RE.sub("[email removed]", s)
    s = PHONE_RE.sub("[phone removed]", s)
    return s.strip()


def scrub_raw(rec: dict) -> dict:
    out: dict[str, Any] = {}
    for k, v in rec.items():
        if PII_KEYS.search(k) and k not in KEEP_KEYS:
            continue
        if isinstance(v, str):
            v = scrub_text(v)
        elif isinstance(v, dict):
            v = scrub_raw(v)
        elif isinstance(v, list):
            v = [scrub_raw(x) if isinstance(x, dict) else (scrub_text(x) if isinstance(x, str) else x) for x in v][:60]
        out[k] = v
    # keep raw rows bounded (related-item blobs on eBay can be huge)
    for k in ("related_items", "you_may_also_like", "related_sponsored_items", "most_relevant_reviews",
              "item_reviews", "popular_categories", "variants", "all_variations"):
        out.pop(k, None)
    return out


def parse_money(v: Any) -> float | None:
    """'$1,234.50', 'US $24.99', 25, 'Free' -> float. None when there is no number."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return round(float(v), 2)
    s = str(v).strip().lower()
    if not s:
        return None
    if s.startswith("free") or s in ("0", "$0"):
        return 0.0
    m = re.search(r"(\d[\d,]*(?:\.\d{1,2})?)", s)
    if not m:
        return None
    return round(float(m.group(1).replace(",", "")), 2)


def parse_ts(v: Any) -> datetime | None:
    if not v:
        return None
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _photos(*candidates: Any) -> list[str]:
    urls: list[str] = []
    for c in candidates:
        if not c:
            continue
        if isinstance(c, str):
            c = [c]
        for u in c:
            if isinstance(u, dict):
                u = u.get("url") or u.get("src")
            if isinstance(u, str) and u.startswith("http") and u not in urls:
                urls.append(u)
    return urls[:MAX_PHOTOS]


def _locate(city_text: str | None) -> tuple[str | None, float | None, float | None]:
    place = geo.lookup(city_text)
    if place:
        return city_text, place["lat"], place["lng"]
    return city_text, None, None


def _base(source: str, external_id: str, url: str, title: str, rec: dict) -> dict:
    return {
        "source": source, "external_id": str(external_id), "url": url, "title": (scrub_text(title) or "")[:300],
        "description": None, "price_usd": None, "shipping_usd": None, "ships": False,
        "city": None, "lat": None, "lng": None, "photo_urls": [], "posted_at": None,
        "raw": scrub_raw(rec),
    }


# --------------------------------------------------------------------------- Facebook Marketplace
def normalize_fb(rec: dict) -> dict:
    if rec.get("error") or rec.get("error_code"):
        raise Skip(f"error row: {rec.get('error_code') or rec.get('error')}")
    if rec.get("is_sold"):
        raise Skip("sold")
    pid = rec.get("product_id")
    title = rec.get("title")
    url = rec.get("url")
    if not (pid and title and url):
        raise Skip("missing id/title/url")
    row = _base("fb_marketplace", pid, f"https://www.facebook.com/marketplace/item/{pid}", title, rec)
    row["description"] = scrub_text(rec.get("description") or rec.get("seller_description"))
    price = parse_money(rec.get("final_price"))
    if price is None:
        price = parse_money(rec.get("initial_price"))
    row["price_usd"] = price
    if (rec.get("currency") or "USD").upper() != "USD":
        raise Skip("non-USD")
    row["city"], row["lat"], row["lng"] = _locate(rec.get("location"))
    row["photo_urls"] = _photos(rec.get("images"))
    row["posted_at"] = parse_ts(rec.get("listing_date"))
    if not row["photo_urls"]:
        raise Skip("no photos")
    return row


# --------------------------------------------------------------------------- eBay
def _ebay_shipping(rec: dict) -> float | None:
    for k in ("shipping", "service_shipping"):
        v = rec.get(k)
        if v is None or v == "" or isinstance(v, bool):
            continue
        if isinstance(v, (list, dict)):
            v = json.dumps(v)
        s = str(v).lower()
        if "local pickup" in s and "$" not in s and "free" not in s:
            continue
        if "free" in s:
            return 0.0
        m = parse_money(s)
        if m is not None:
            return m
    return None


def normalize_ebay(rec: dict) -> dict:
    if rec.get("error") or rec.get("error_code"):
        raise Skip(f"error row: {rec.get('error_code') or rec.get('error')}")
    if rec.get("is_sold") or rec.get("sold_date"):
        raise Skip("sold")
    pid = rec.get("product_id") or rec.get("item_id")
    title = rec.get("title")
    if not (pid and title):
        raise Skip("missing id/title")
    cond = str(rec.get("condition") or "").lower()
    if cond.startswith("new") and "other" not in cond and "open" not in cond:
        raise Skip("new item (we only list used)")
    url = rec.get("url") or f"https://www.ebay.com/itm/{pid}"
    u = urlparse(url)
    url = f"{u.scheme}://{u.netloc}{u.path}"          # drop tracking query strings
    row = _base("ebay", pid, url, title, rec)
    desc = rec.get("description") or rec.get("description_from_the_seller")
    specs = rec.get("product_specifications")
    if isinstance(specs, list):
        bits = [f"{s.get('specification_name')}: {s.get('specification_value')}" for s in specs
                if isinstance(s, dict) and s.get("specification_name") and s.get("specification_value")]
        if bits:
            desc = ((desc or "") + "\n" + "; ".join(bits[:25])).strip()
    row["description"] = scrub_text(desc)[:4000] if desc else None
    row["price_usd"] = parse_money(rec.get("sale_price")) if rec.get("sale_price") else None
    if row["price_usd"] is None:
        row["price_usd"] = parse_money(rec.get("price"))
    cur = str(rec.get("currency") or "USD").upper()
    if cur not in ("USD", "US", "$", "US $"):
        raise Skip("non-USD")
    ship = _ebay_shipping(rec)
    row["shipping_usd"] = ship
    row["ships"] = ship is not None
    loc = rec.get("item_location") or ", ".join(x for x in (rec.get("city"), rec.get("state")) if x)
    row["city"] = loc or None
    # eBay items have no pickup distance (spec 7): keep coordinates only when the item is actually local
    place = geo.lookup(loc) if loc else None
    if place and "san diego" in (loc or "").lower() or (place and place["name"] != "San Diego"):
        row["lat"], row["lng"] = place["lat"], place["lng"]
    row["photo_urls"] = _photos(rec.get("images"), rec.get("image_url"))
    if not row["photo_urls"]:
        raise Skip("no photos")
    if not row["ships"] and row["lat"] is None:
        # no shipping price captured and not local: we cannot show an honest total cost, so leave it out
        raise Skip("shipping cost unknown and not local")
    return row


# --------------------------------------------------------------------------- Craigslist (Web Unlocker HTML)
# old: https://sandiego.craigslist.org/sdo/fuo/d/slug/7712345678.html   new (Nov 2026): https://www.craigslist.org/view/d/slug/88fnGUEBYr7wGWiJqHCHLA
CL_ID_RE = re.compile(r"/(\d{8,})\.html|/view/d/[^/?#]+/([A-Za-z0-9]{8,})")


def cl_id(url: str) -> str | None:
    m = CL_ID_RE.search(url or "")
    return (m.group(1) or m.group(2)) if m else None


def parse_craigslist_search(html: str, base_url: str = "https://sandiego.craigslist.org") -> list[dict]:
    """Parse a Craigslist search page fetched through Web Unlocker.

    Craigslist serves a static result list for non-JS clients (li.cl-static-search-result) and an
    ld+json ItemList with images and coordinates. We read both and merge them by position.
    """
    from selectolax.lexbor import LexborHTMLParser

    tree = LexborHTMLParser(html)
    ld_items: list[dict] = []
    for s in tree.css("script#ld_searchpage_results, script[type='application/ld+json']"):
        try:
            data = json.loads(s.text() or "{}")
        except ValueError:
            continue
        if isinstance(data, dict) and data.get("itemListElement"):
            ld_items = [e.get("item", e) for e in data["itemListElement"] if isinstance(e, dict)]
            break

    rows: list[dict] = []
    for i, li in enumerate(tree.css("li.cl-static-search-result")):
        a = li.css_first("a")
        if not a:
            continue
        href = urljoin(base_url, a.attributes.get("href") or "")
        if not cl_id(href):
            continue
        title_el = li.css_first(".title")
        price_el = li.css_first(".price")
        loc_el = li.css_first(".location")
        title = (title_el.text(strip=True) if title_el else li.attributes.get("title") or "").strip()
        if not title:
            continue
        rec: dict[str, Any] = {
            "url": href, "title": title,
            "price": price_el.text(strip=True) if price_el else None,
            "location": loc_el.text(strip=True) if loc_el else None,
        }
        ld = ld_items[i] if i < len(ld_items) else None
        if ld and (ld.get("name") or "").strip().lower()[:20] == title.lower()[:20]:
            rec["images"] = ld.get("image") if isinstance(ld.get("image"), list) else [ld.get("image")]
            place = (ld.get("offers") or {}).get("availableAtOrFrom") or {}
            geo_ = place.get("geo") or {}
            rec["latitude"], rec["longitude"] = geo_.get("latitude"), geo_.get("longitude")
            addr = place.get("address") or {}
            rec["location"] = rec["location"] or addr.get("addressLocality")
            if rec["price"] is None:
                rec["price"] = (ld.get("offers") or {}).get("price")
        rows.append(rec)
    return rows


def parse_craigslist_post(html: str, url: str) -> dict | None:
    """One Craigslist post page (Web Unlocker HTML) -> the same record shape as a search result row."""
    from selectolax.lexbor import LexborHTMLParser

    tree = LexborHTMLParser(html)
    item: dict = {}
    for s in tree.css("script[type='application/ld+json']"):
        try:
            data = json.loads(s.text() or "{}")
        except ValueError:
            continue
        if isinstance(data, dict) and data.get("offers") and data.get("name"):
            item = data
            break
    title_el = tree.css_first("#titletextonly")
    title = (title_el.text(strip=True) if title_el else item.get("name") or "").strip()
    if not title:
        return None
    body = tree.css_first("#postingbody")
    desc = body.text(strip=True).replace("QR Code Link to This Post", "").strip() if body else None
    offers = item.get("offers") or {}
    place = offers.get("availableAtOrFrom") or {}
    geo_, addr = place.get("geo") or {}, place.get("address") or {}
    images = item.get("image") or []
    price_el = tree.css_first(".price")
    return {"url": url, "title": title, "description": desc,
            "price": offers.get("price") or (price_el.text(strip=True) if price_el else None),
            "location": addr.get("addressLocality"), "latitude": geo_.get("latitude"), "longitude": geo_.get("longitude"),
            "images": [i.replace("_600x450", "_1200x900") for i in (images if isinstance(images, list) else [images])]}


def normalize_craigslist(rec: dict, free_section: bool = False) -> dict:
    url = rec.get("url") or ""
    pid = cl_id(url)
    title = rec.get("title")
    if not (pid and title):
        raise Skip("missing id/title")
    row = _base("craigslist", pid, url.split("?")[0].split("#")[0], title, rec)
    row["description"] = scrub_text(rec.get("description"))
    price = parse_money(rec.get("price"))
    row["price_usd"] = 0.0 if (free_section and price is None) else price
    loc = rec.get("location")
    row["city"] = loc or "San Diego"
    lat, lng = rec.get("latitude"), rec.get("longitude")
    try:
        if lat is not None and lng is not None:
            # neighborhood-level only: round to ~1 km so we never store an exact address point
            row["lat"], row["lng"] = round(float(lat), 2), round(float(lng), 2)
    except (TypeError, ValueError):
        pass
    if row["lat"] is None:
        place = geo.lookup(loc) or geo.lookup("San Diego")
        row["lat"], row["lng"] = place["lat"], place["lng"]
    row["photo_urls"] = _photos(rec.get("images"))
    if not row["photo_urls"]:
        raise Skip("no photos")
    return row


NORMALIZERS = {"fb_marketplace": normalize_fb, "ebay": normalize_ebay, "craigslist": normalize_craigslist}


def normalize(source: str, rec: dict) -> dict:
    return NORMALIZERS[source](rec)
