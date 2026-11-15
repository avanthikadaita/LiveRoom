"""Stretch features end to end on the pipeline harness: seller drafts and corner sets."""
from __future__ import annotations

from worker.limits import ProviderError
from worker.stages import seller, sets
from worker.stages.seller import guess_category
from worker.tests.test_pipeline import ctx, run_until_settled, seed  # noqa: F401 - pytest fixture
from worker.usd_validate import validate_usdz


def new_draft(ctx, **kw) -> int:  # noqa: F811
    row = {"photo_url": "https://blob.example/seller/1.jpg", "height_in": 30, "title": "Wooden side table",
           "ask_usd": 25, "city": "La Jolla", **kw}
    return ctx.db.one("""insert into seller_drafts (photo_url, height_in, title, ask_usd, city)
                         values (%(photo_url)s, %(height_in)s, %(title)s, %(ask_usd)s, %(city)s) returning id""", row)["id"]


def test_guess_category_from_title():
    assert guess_category("IKEA Hemnes nightstand, white") == "nightstand"
    assert guess_category("cute desk lamp!!") == "desk_lamp"
    assert guess_category("Tall lamp") == "desk_lamp"
    assert guess_category("Floor lamp brass") == "floor_lamp"
    assert guess_category("Comfy armchair") == "accent_chair"
    assert guess_category("mystery box") == "other"


def test_seller_draft_becomes_a_true_scale_real_model_with_a_fair_price(ctx, monkeypatch):  # noqa: F811
    seed(ctx)                                          # 3 scraped side tables = the comparables
    monkeypatch.setenv("REAL_3D_FOR", "pinned")         # scraped items get generic; the seller's item must not
    did = new_draft(ctx)
    assert seller.run(ctx) == 1
    d = ctx.db.one("select * from seller_drafts where id = %s", (did,))
    assert d["status"] == "processing" and d["category"] == "side_table" and d["listing_id"]
    assert d["comps_n"] == 3 and d["fair_price_usd"] is not None
    assert d["fair_low_usd"] <= d["fair_price_usd"] <= d["fair_high_usd"] and len(d["comp_urls"]) == 3
    lst = ctx.db.one("select * from listings where id = %s", (d["listing_id"],))
    assert lst["source"] == "FitCheck" and not lst["is_active"] and lst["lat"] is not None   # La Jolla, from geo
    det = ctx.db.one("select * from listing_details where listing_id = %s", (d["listing_id"],))
    assert (float(det["w_in"]), float(det["d_in"]), float(det["h_in"])) == (25.0, 20.0, 30.0)  # 20x16x24 scaled to 30

    assets = run_until_settled(ctx)
    mine = assets[d["listing_id"]]
    assert mine["status"] == "ready" and mine["provider"] == "tripo" and not mine["is_approx_model"]
    assert float(mine["final_h_in"]) == 30.0
    others = [a for lid, a in assets.items() if lid != d["listing_id"]]
    assert all(a["provider"] == "generic" for a in others)
    seller.run(ctx)                                     # sync pass
    assert ctx.db.one("select status from seller_drafts where id = %s", (did,))["status"] == "ready"
    # never shown in search until the seller publishes it
    assert d["listing_id"] not in [r["id"] for r in ctx.db.q("select id from listing_cards(32.88, -117.24)")]


def test_seller_works_when_gemini_is_out_of_quota(ctx):  # noqa: F811
    ctx.gemini.fail_with = ProviderError("gemini 429", quota=True, quota_kind="day")
    did = new_draft(ctx, title="Grey storage ottoman", height_in=16)
    seller.run(ctx)
    d = ctx.db.one("select * from seller_drafts where id = %s", (did,))
    assert d["status"] == "processing" and d["category"] == "ottoman"
    assert d["fair_price_usd"] is None and d["comps_n"] == 0          # no comparables: no made-up price
    det = ctx.db.one("select h_in, model_used from listing_details where listing_id = %s", (d["listing_id"],))
    assert float(det["h_in"]) == 16.0 and det["model_used"] == "seller:title"


def test_seller_category_from_the_form_wins(ctx):  # noqa: F811
    ctx.gemini.fail_with = ProviderError("gemini 429", quota=True, quota_kind="day")
    did = ctx.db.one("""insert into seller_drafts (photo_url, height_in, title, category)
                        values ('https://blob.example/seller/2.jpg', 28, 'Old wooden thing', 'nightstand') returning id""")["id"]
    seller.run(ctx)
    d = ctx.db.one("select * from seller_drafts where id = %s", (did,))
    assert d["category"] == "nightstand"
    det = ctx.db.one("select category, h_in, w_in from listing_details where listing_id = %s", (d["listing_id"],))
    assert det["category"] == "nightstand" and float(det["h_in"]) == 28.0 and det["w_in"] is not None


def test_corner_set_exports_one_usdz_with_items_placed(ctx):  # noqa: F811
    seed(ctx)
    assets = run_until_settled(ctx)
    ids = list(assets)[:2]
    sid = ctx.db.one("insert into sets (title, prompt) values ('Reading corner', 'two tables') returning id")["id"]
    for i, lid in enumerate(ids):
        ctx.db.x("insert into set_items (set_id, listing_id, pos) values (%s, %s, %s)", (sid, lid, i))
    assert sets.run(ctx) == 1
    s = ctx.db.one("select * from sets where id = %s", (sid,))
    assert s["status"] == "ready" and s["usdz_url"] and s["glb_url"] and s["error"] is None
    rep = validate_usdz(ctx.storage.get(s["usdz_url"]), expect_h_in=24, tol_in=0.75)
    assert rep.ok, rep.errors
    assert abs(rep.size_in[0] - float(s["w_in"])) < 1.0              # both tables side by side
    items = ctx.db.q("select * from set_items where set_id = %s order by pos", (sid,))
    assert all(i["placed"] for i in items) and items[0]["x_in"] != items[1]["x_in"]


def test_corner_set_with_an_unfinished_item_fails_clearly(ctx):  # noqa: F811
    seed(ctx)
    lid = ctx.db.one("select id from listings limit 1")["id"]           # tagged, no asset yet
    sid = ctx.db.one("insert into sets (title) values ('x') returning id")["id"]
    ctx.db.x("insert into set_items (set_id, listing_id) values (%s, %s)", (sid, lid))
    sets.run(ctx)
    s = ctx.db.one("select status, error from sets where id = %s", (sid,))
    assert s["status"] == "failed" and "without a finished model" in s["error"]
