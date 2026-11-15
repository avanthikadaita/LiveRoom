# NOTES

Decisions, API differences found, and open issues. Person A (worker, db, scripts), Nov 14 2026.

## Run it

```
py -3.13 -m venv .venv && .venv\Scripts\pip install -r worker\requirements.txt && .venv\Scripts\playwright install chromium
copy .env.example worker\.env          # fill in values, never commit
npm install --prefix worker/meshtools  # glTF-Transform + meshoptimizer (shrinks hand-made models)
python -m scripts.migrate              # db/001, 003, 004, 005 (idempotent)
python -m scripts.seed_demo --embed    # FAKE fixtures for Person B (drop_fixtures removes them)
python -m worker.run --loop           # seller,scrape,tag,select,cutout,gen,export,sets
python -m scripts.import_model --url <marketplace/eBay item URL> --glb chair.glb   # Person D's models
python -m scripts.curate status | candidates | pin <ids> | previews | orient <id> <o>
python -m scripts.branch_demo ; python -m scripts.demo_check
python -m pytest worker/tests          # worker tests
npm --prefix web/mastra test && npm --prefix web/mastra run eval   # Mastra unit tests + filter eval
```

Python 3.13 (3.14 has no wheels for rembg/usd-core). Tests need a Postgres with pgvector:
`node scripts/localpg/server.mjs 54329 memory` (PGlite stand-in) or `TEST_DATABASE_URL` = a Neon test branch.
Tests run in their own schema and drop it.

## API differences found (docs win over the spec)

- **Bright Data Marketplace**: `discover_by=keyword` answers "Customer is not active" on our account.
  `discover_by=url` with `https://www.facebook.com/marketplace/sandiego/search/?query=...` works. Used that.
- **Bright Data eBay**: discovery type is `keywords` (plural), input `{"keywords": "..."}`. Slow: 4 records took ~12 min.
  Many records have no shipping price; those are skipped unless local (we cannot show an honest total).
- **Dataset ids**: FB `gd_lvt9iwuh6fbcwmx1a`, eBay `gd_ltr9mjt81n0zzdk1fb`.
- **Gemini**: `gemini-2.5-flash` is retired (404). 3.8/3.7-flash returned 503 "high demand" on Saturday.
  `GEMINI_MODEL_VISION` is a comma list tried in order; an overloaded model is benched 5 min.
  Embeddings: `gemini-embedding-001`, 768 dims, L2-normalized, task type RETRIEVAL_DOCUMENT.
  **Person B: embed queries with the same model and dim, task type RETRIEVAL_QUERY.**
- **Meshy**: the key in our file works through the API (spec said no key). Textured image-to-3D costs 30 credits;
  we had 100, 70 left after one test. 402 = out of credits or free plan.
- **Tripo**: both valid keys have API balance 0 (code 2010); third key fails auth (1002, looks truncated).
  Website credits do not apply to the API. Keys are cooled down automatically and the chain moves on.
- **Hugging Face**: TRELLIS works end to end (~54 s, good quality) with `httpx_kwargs={"timeout": 300}` and a
  `/preprocess_image` call first (the default 6 s timeout killed it). Its raw GLB omits metallicFactor and renders
  black; export fixes that. stable-fast-3d fails with a hidden AppError; it stays second in the list.
- **Provider order**: `PROVIDER_ORDER=hf,meshy,tripo` in worker/.env so free TRELLIS goes first and Meshy's
  last credits are kept for when HF is out of GPU quota.
- **Gemini free quota is per model, per key.** The limits ledger is keyed `gemini/<model>`; when one model's
  daily quota is used up the tagger falls through to the next model instead of stopping until 08:00 UTC.
- **Tripo website**: downloads need a paid plan (free plan only previews). Not a bug. Use Meshy's site, TRELLIS
  via the worker (pin the listing), or any tool that gives a .glb, then `scripts.import_model`.
- **usd-core 26.11**: `pxr.UsdValidation` works; we run 10 validators plus our own size/base/metallic/texture checks.

## Decisions

- **No Amazon (team decision, Sat Nov 14).** New-price baselines and the "savings vs. new" number are dropped:
  pointing people at new products defeats the point (keeping used furniture out of landfill). The baseline stage,
  its tests and BD_DATASET_AMAZON were removed. The `new_price_baselines` table still exists but stays empty.
- **Car fit is parked (team decision).** `cars` table and `scripts.load_data` are kept but unused; demo_check
  no longer requires cars. Priority is the model on the phone, then distance, price and shipping.
- **Distance / total cost / delivery live in Neon**: `listing_cards(origin_lat, origin_lng[, fuel_per_mile])`
  (db/004). ~miles = haversine x 1.3, drive minutes at 25 mph, pickup cost = round trip x $0.15/mi,
  total = cheaper of price + shipping and price + pickup, `delivery` says which. Rows without an honest total
  (no location and no shipping price) are not returned. Person B: build the search on top of it.
- **Hand-made models** (Person D, Tripo/Meshy websites): `scripts.import_model` fetches the listing through
  Bright Data if it is not in Neon yet, tags it, shrinks the GLB to <= 80k triangles and 2K textures
  (glTF-Transform + meshoptimizer), stores it as provider `manual` (real model, not approx), pins the listing,
  exports and validates right away, and writes a preview PNG. Seam-heavy textured meshes are NOT sloppy-simplified:
  it smeared a Meshy texture in testing, so those stay heavier instead.

- **Auto-orient is conservative.** A model is only turned if another orientation beats "as generated" by a margin
  AND halves the mismatch (bigger margin when the target is only a category prior). The first version tipped a
  tall slim real side table onto its side. Upside-down cannot be detected from ratios: use `orient_override`.
- **`listing_details.dims_from_text`** keeps the tagger's verdict; export may downgrade `dims_source` for the UI.
- **Generic fallback models** are our own procedural GLBs (`scripts/make_generic_assets`), never auto-rotated,
  and stretched to the listing's W x D x H so the AR footprint is honest. Always `is_approx_model = true`.
- **`REAL_3D_FOR=pinned`** (default): provider credits are spent only on `demo_pin` listings. Others get the generic
  model at once and are upgraded automatically when pinned later. `all` / `none` also accepted.
- **Multi-photo is opt-in (`MULTI_PHOTO=1`).** One live Meshy comparison only: the 2-photo result had a dark
  artifact on the table top. The 3-fixture single vs multi comparison from the spec is NOT done (credits).
- **Blob paths** are deterministic: `cutout/{id}-{i}.png`, `glb/{id}-raw-{provider}.glb`, `usdz/{id}-v{n}.usdz`.
  `version` bumps on re-export so Quick Look never shows a cached file.
- **Main photo is mirrored to Blob** at cutout time (fbcdn links expire) and replaces that entry in `photo_urls`.
- **Craigslist** is live: Web Unlocker zone `web_unlocker1` + local HTML parse. Craigslist moved to
  `/view/d/<slug>/<base62id>` URLs; the parser handles both formats (test fixture trimmed from a real page).
  ld+json carries photos and geo for only ~45 of ~340 static results per page. Cost: $1.50 / 1000 successful
  requests, ~150/day, covered by the free credits.
- **Distance honesty**: 138 of 181 FB listings say only "San Diego, CA". `listing_cards.loc_precise` is false for
  those; the Mastra search keeps them when the radius is >= 10 mi and says "in San Diego" instead of a distance.
- **Corner sets** (`worker/arrange.py`, `stages/sets.py`): backs to a wall at z=0; lamp on the side table / desk;
  a chair in front of a desk faces it (yaw 180); others alternate right/left angled 20 deg. One USDZ + GLB per set,
  validated for overall height. Set 1 (chair + side table + lamp) built live on Neon/Blob.
- **Seller flow** (`stages/seller.py`, db/005): `seller_drafts` row (photo, height, title, ask) -> hidden listing
  with source `FitCheck` -> tagged (or category guessed from the title) -> scaled to the seller's height ->
  always real 3D, ahead of the queue. Fair price = p25/median/p75 of active comparable listings (>= 3 comps,
  similar height preferred). Draft goes ready/failed with its asset.
- **Mastra** (`web/mastra`, @mastra/core 1.83): `FitCheckFilterExtractor` agent (Gemini flash-lite, structured
  output, key rotation, keyword fallback) + `furnishCorner` workflow + code scorer. Eval on 25 labelled queries:
  LLM 0.995 (24/25 exact, median ~860 ms). Keyword fallback also 0.995, but it was tuned on the same set, so read
  that as an upper bound.
- Extra tables/columns are in `db/003_worker_extras.sql` (error_log, scrape_jobs, sets, orient_override, gen_state...).
- Tests use a schema on any Postgres instead of a dedicated Neon test branch.

## Merged with Person B's web app (Nov 14 evening)

- Pulled `cb506ef` (web app). Our standalone Mastra package was folded into `web/`: `furnishCorner` now lives in
  `web/mastra/workflows/` and reuses the web search SQL, so corner totals match the cards. See `web/NOTES.md`.
- New web routes: `/corner`, `/api/corner`, `/api/corner/[id]`, `/api/seller/draft`, `/api/seller/draft/[id]`;
  `/sell` now runs the real seller pipeline. `listing_cards`-style `loc_precise` handling added to the web search.
- Verified locally against Neon with `next start`: health, TTS, STT, search (2/3 demo queries; no shipped accent
  chair with a model yet), corner plan -> set built by the worker in ~15 s, seller draft -> real TRELLIS model +
  fair price, publish token check. Test seller listings were unpublished afterwards.
- Worker runs as two processes (scrape+tag | everything else): tagging no longer blocks model building.
  AR-ready listings went 77 -> 154 in ~6 min.
- `demo_check` sent `{query}`; the web route takes `{text}`. Fixed.

## Open issues

1. **Vercel**: Root Directory must be `web` (the current deploys are empty, every URL is NOT_FOUND). Add
   `BLOB_READ_WRITE_TOKEN` to the Vercel env (it is not in the secrets that were added). Redeploy after both.
2. **Nothing is committed or pushed.** Vercel builds from GitHub, so none of Person A's work or the merge fixes are
   live until they are pushed.
3. **Demo pins need a human**: pick 8+ good listings (`python -m scripts.curate candidates`, then `pin`). Then run
   `python -m scripts.branch_demo` (Neon API key works; dry run OK) and set `DATABASE_URL_DEMO` + `DEMO_MODE=1` in
   Vercel if you want the frozen demo branch, then `npm --prefix web run snapshot`.
4. Inventory gaps: no desk with a model yet, 1 dining chair, 1 floor lamp, no shipped accent chair. eBay is thin.
5. Gemini 3.x flash daily quotas are used up until midnight Pacific; tagging continues on flash-lite at 6 RPM
   (shared with the web app's parser on the same keys).
6. Tripo API balance is 0; SF3D on HF is broken. Car fit is parked. On-device AR not yet tried on a real iPhone.
