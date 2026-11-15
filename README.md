# FitCheck

See real second-hand furniture from Craigslist, Facebook Marketplace and eBay in your own room, in AR on your
phone, before you drive across town for it. Buying used keeps furniture out of landfill, and the AR model
answers the question a photo can't: "will it actually fit?"

Each listing comes with:
- **A real 3D model** (USDZ for iPhone Quick Look, GLB for Android/WebXR), scaled to the listing's dimensions.
- **An honest total**: price plus shipping, or price plus an estimated pickup cost.
- **Distance and drive time** from you.

One sentence ("study corner under $60, I don't have a car") turns into a few items that fit the budget. They
arrive as one arranged AR scene.

## How it fits together

```
Bright Data ──► worker (Python) ──────────────────────────────► Neon Postgres + pgvector
 FB Marketplace   scrape → tag (Gemini vision + embeddings)       listings, listing_details, assets,
 eBay             → select → cutout (rembg) → gen (3D)            sets, seller_drafts, listing_cards()
 Craigslist       → export (USDZ + GLB, validated) → sets              │
 (Web Unlocker)   → seller drafts                                      │
                         │                                             ▼
                         └──► Vercel Blob (photos, cutouts, GLB, USDZ) ◄── web/ (Next.js on Vercel)
                                                                             voice search, AR cards,
                                                                             /corner, /sell, /pipeline,
                                                                             /impact, /admin
                                                                             web/mastra: FitCheckShopper
                                                                             agent + furnishCorner workflow
```

| Sponsor track | Where it's used |
|---|---|
| **Bright Data** | Datasets API for FB Marketplace (`discover_by=url`) and eBay (`keywords`). Web Unlocker zone `web_unlocker1` for Craigslist search pages. Both are parsed and normalized into one schema (`worker/normalize.py`). |
| **Neon** | Postgres 18 + pgvector. Holds listings, tags, 768-dim embeddings, the asset pipeline state machine, corner sets and seller drafts. `listing_cards()` computes distance, drive time, pickup cost and total in SQL, so cards, search and spoken replies always agree. `scripts/branch_demo` makes a demo branch. |
| **MLH Gemini** | Vision tagging: category, style, condition, W×D×H and best photo for every listing. `gemini-embedding-001` for semantic search (documents and queries, 768 dims). One function call turns a spoken request into search filters (~1 s). The free quota is per model per key, so both the worker and the web rotate keys and track each model separately. |
| **Mastra** | `web/mastra`: the `FitCheckShopper` agent (5 tools, Neon-backed memory; `SEARCH_ENGINE=agent`) and the `furnishCorner` workflow behind **/corner**: `plan → .foreach(search-category, concurrency 3, retries 2) → pick-within-budget → queue set`. The worker then arranges the picked items into one USDZ. 25-query filter eval: `npm --prefix web run evals`. |
| **ElevenLabs** | Speech to text (`scribe_v1`) for voice search, text to speech (`eleven_flash_v2_5`) reads every result summary aloud, including the corner plan. |
| **GoDaddy** | Person B/C: domain. |

## Run it

Needs Python 3.13 (3.14 has no wheels for rembg/usd-core) and Node 20+.

```bash
py -3.13 -m venv .venv
.venv\Scripts\pip install -r worker\requirements.txt
copy .env.example worker\.env
npm install --prefix worker/meshtools
npm install --prefix web
python -m scripts.migrate
python -m worker.run --loop
```

Fill in the values in `worker\.env` after copying it, and never commit it.

`python -m scripts.migrate` applies `db/001`, `003`, `004` and `005`. It is idempotent.

The worker's default stages are `seller,scrape,tag,select,cutout,gen,export,sets`.

| Command | What it does |
|---|---|
| `python -m scripts.curate status` | Pipeline counts |
| `python -m scripts.curate candidates` | Good listings to pin for the demo |
| `python -m scripts.curate pin 12 15 31` | Pinned items get real 3D models (others get approx models) |
| `python -m scripts.import_model --url <item URL> --glb chair.glb` | Bring in a hand-made model (below) |
| `python -m scripts.make_set 12 15 31 --title "Study corner"` | Build a corner set by hand |
| `npm --prefix web run dev` | Web app on localhost:3000 (reads `web/.env.local`) |
| `npm --prefix web run live-check` | PASS/FAIL for every live integration |
| `npm --prefix web run corner-check -- "study corner under $120"` | Run the Mastra corner workflow on Neon (plans only) |
| `npm --prefix web run evals` | Filter-extraction eval |
| `python -m scripts.demo_check` | Pre-demo checklist |
| `python -m pytest worker/tests` | Worker tests (needs a Postgres with pgvector, below) |
| `npm --prefix web test` | Web unit tests (vitest) |

Tests need a Postgres with pgvector. Use either:
- `node scripts/localpg/server.mjs 54329 memory` (a local PGlite stand-in) with
  `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres`, or
- a Neon branch.

## Deploy (Vercel)

The Next.js app lives in `web/`. In the Vercel project, open **Settings → Build and Deployment → Root Directory**,
set it to `web` and save. Then redeploy. Without that setting the build finishes in seconds with nothing in it, and
every URL returns NOT_FOUND.

Environment variables (Production) are listed in `web/.env.example`. Besides the ones already set, add
`BLOB_READ_WRITE_TOKEN` (needed for /sell and the /admin GLB upload). Variables only take effect on the next deploy.

The Python worker does not run on Vercel. It runs on a laptop (or any always-on machine) with `python -m worker.run --loop`.
To keep tagging from holding up model building, run it as two processes:

```bash
python -m worker.run --loop --stages scrape,tag
python -m worker.run --loop --stages seller,select,cutout,gen,export,sets
```

## The 3D pipeline

1. **Tag.** Gemini reads the photos and returns category and dimensions. Listings where the dimensions come from
   the listing text are marked as such; others are estimated from the category.
2. **Cutout.** rembg removes the background. The cutout is rejected if the object covers less than 8% of the photo.
3. **Generate.** Providers are tried in `PROVIDER_ORDER`. We run `hf,meshy,tripo` so free models go first:
   - **Hugging Face TRELLIS** (free, about 1 min, good quality, a few runs per day per token).
   - **Meshy** (paid credits).
   - **Tripo** (API balance is 0).

   Only pinned listings and seller items spend credits (`REAL_3D_FOR=pinned`). Every other listing gets a
   procedural approximate model right away, stretched to its W×D×H and labelled approx.
4. **Export.** The model is oriented, scaled to real inches, given a base at y=0, and baked into USDZ and GLB.
   It is then validated with `pxr.UsdValidation` plus our own checks (size, metallic, textures).
5. **Corner sets.** `worker/arrange.py` places 1–4 items against a wall:
   - A lamp goes on the side table.
   - A chair goes in front of the desk, facing it.
   - Other items stand beside the anchor, angled in.

   The result is one USDZ you can walk around.
6. **Seller flow.** A `seller_drafts` row needs a photo, the item's height and a title. The worker turns it into
   a hidden `FitCheck` listing with a real 3D model. It also suggests a fair price: the p25 / median / p75 of
   similar active listings, used only when there are at least 3 comparables.

### Person D: hand-made models (Tripo / Meshy websites)

The Tripo website only allows downloads on a paid plan. Free-plan exports ask for Pro, so that's expected and
not a bug. Meshy's website allows a few free downloads.

Any `.glb` from any tool works:

```bash
python -m scripts.import_model --url "https://www.facebook.com/marketplace/item/123..." --glb models_in/chair.glb
```

For a batch, use `--csv models_in/models.csv` (columns `url,glb,orient`). The script:
1. Fetches the listing through Bright Data if needed.
2. Shrinks the mesh to 80k triangles (150k makes a USDZ over 15 MB) and 2K textures.
3. Uploads it and pins the listing.
4. Exports and validates it.
5. Writes `previews/import-<id>.png` so you can check it.

If you can't export at all, don't: pin the listing (`scripts.curate pin <id>`) and the worker makes the model
itself with free TRELLIS.

## Search API for the web app

```sql
select * from listing_cards(32.8801, -117.2376)        -- origin, e.g. UCSD
where ar_ready and category = any('{side_table,desk_lamp}') and total_usd <= 40
  and (ships or est_miles <= 10 or (not loc_precise))
order by embedding <=> $1::vector limit 20;
```

For the query embedding, use `gemini-embedding-001`, 768 dims, task type `RETRIEVAL_QUERY`.

`loc_precise = false` means the listing only says "San Diego". Show "San Diego, area unknown" instead of a
distance.

The web app's search (`web/lib/search/sql.ts`) does the same math in one hybrid query. The corner workflow is
`web/mastra/workflows/furnishCorner.ts`, served by `POST /api/corner {text}`. Poll `GET /api/corner/<set_id>` until
`status = 'ready'` and open
`usdz_url`.

More decisions, API differences and open issues are in [NOTES.md](NOTES.md).
