# FitCheck handoff (Person A work, Sat Nov 14 2026)

Paste this into a new Claude session together with README.md, NOTES.md and web/NOTES.md.

## State right now

- Live site: https://FitCheck-lac.vercel.app (Vercel project "FitCheck", Root Directory `web`, builds from GitHub `main`).
  Env vars are set in Vercel (DB, Gemini, ElevenLabs, Blob, admin token, Bright Data).
- Neon project misty-band-10705228 (default branch is called `production`). Blob store qs1nw3xcnxvisvzh.
- Secrets live ONLY in `worker/.env`, `web/.env.local` and the git-ignored `SanD Hacks API Keys` file. Never commit them.
- The Python worker runs on Abhi's laptop as two processes (must stay running; Vercel does not run it):
  ```
  .venv\Scripts\python -m worker.run --loop --stages scrape,tag
  .venv\Scripts\python -m worker.run --loop --stages seller,select,cutout,gen,export,sets
  ```
  Logs: `worker/.cache/worker_tag.log`, `worker/.cache/worker_run.log`.
- Tests: `python -m pytest worker/tests` (needs `node scripts/localpg/server.mjs 54329 memory` and
  `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres`), `npm --prefix web test`, `npx tsc --noEmit` in web.
  Pre-demo check: `python -m scripts.demo_check --site https://FitCheck-lac.vercel.app`.

## 3D providers (worker/.env)

- `PROVIDER_ORDER=meshy,hf,tripo`. Meshy: 5 keys, ~370 credits total (~30 per textured model, free plan allows
  1 pending task per account). HF TRELLIS: 8 tokens, ~3 free runs/day each, lower quality (misses thin parts).
  Tripo: API balance 0. Website-only Tripo needs Pro to export.
- Only pinned listings (`demo_pin`) and seller items get real 3D (`REAL_3D_FOR=pinned`). Everything else gets a
  generic procedural stand-in model (is_approx_model = true): THIS IS WHAT LOOKS "INACCURATE" ON THE PHONE.
- Hand-made GLBs: `python -m scripts.import_model --id <listing id> --glb file.glb` (shrinks, uploads, pins, exports).

## Done this session (latest first)

- Person D's bookshelf model (Downloads\model (1).glb) imported on listing 37 (gray staggered bookshelf).
- The other Person D GLBs match NO listing in Neon (checked titles + photos). They are:
  model.glb = black L-shaped LED gaming desk; model (1) (1).glb and model (3).glb = brown wicker wingback chair with
  cream cushions; model (2).glb = carved wood Louis-style side table; model (4).glb = gray fabric portable wardrobe;
  Desktop\model.glb = lotus-flower floor lamp. Need the Marketplace/eBay URL each was made from, then
  `python -m scripts.import_model --url <url> --glb <file>` (fetches + tags the listing, shrinks to 80k tris, pins).
- Import/shrink budget lowered 150k -> 80k triangles (150k made a 16 MB USDZ, over the 15 MB AR limit).
- Search ranks real models first (REAL_MODEL_BOOST 0.25); stand-ins are labelled "size stand-in", the button says
  "Check the size in your room" with a note that it is a generic shape, not the item's look.
- Seller fair price: local Craigslist + Marketplace only (no eBay), no sets / table-and-chairs bundles, widens to
  related categories under 5 comps, suggests the 40th percentile rounded to $5 (quick sale = 25th, typical = median).
  Same rule in worker/stages/seller.py and web/app/api/seller/price/route.ts. Existing drafts re-priced
  (white chair $85 -> $30). Sell page tells sellers how to shoot a photo that makes a good model.
- Pipeline removed from the main nav (it is the judges' live board; still at /pipeline, linked from /impact).
- ROOT CAUSE of missing parts / floating fragments: the cutout (rembg u2net) cut away light parts against light
  walls (the white chair back) and kept other furniture in the background. Now BiRefNet-lite (CUTOUT_MODEL) plus
  keep_main_object() (drops mask pieces far from the main object). ~20 s per photo on CPU.
- Meshy and TRELLIS outputs are never auto-rotated (both come out upright).
- Meshy gets the cutout flattened onto mid gray (it composites transparency onto white and then cut the white
  chair back away again). Cutouts and raw models now have content-hashed file names: overwriting the same Blob
  path served the old file from the 1-year CDN cache.
- Seller white chair (listing 1665) now an accurate Meshy model (back, 4 legs, casters):
  previews/chair-1665-before-after.jpg. Meshy credits left: 250 (10/70/45/100/25 per key) = about 6 models;
  keep ~3 for live seller demos.

- Meshy keys added, Meshy first in the chain.
- HF tokens 3 -> 8. TRELLIS models are never auto-rotated (they come out upright).
- Pinned 10 demo listings (18 1060 1145 670 87 1117 459 157 104 93); 8 have real models.
- Pushed everything to main; site live; corner (/corner + Mastra workflow), sell (/sell, real pipeline),
  city-only location honesty, worker split in two, many fixes. See git log.

## Still to do (in order)

1. Get the listing URLs for Person D's 5 unmatched GLBs (above) and import them.
2. Redo the weakest demo-pinned models (made from old u2net cutouts): reset the asset to status 'queued' with
   cutout_url, views_used, provider, provider_job = null and gen_state minus tried/raw_glb_url (new cutout + Meshy,
   30 credits each). When Meshy credits run out, HF TRELLIS still benefits from the better cutout.
3. Pick more demo items with clean photos (`python -m scripts.curate candidates`, `pin <ids>`).
4. Test AR on a real iPhone; optional demo branch (`python -m scripts.branch_demo`).
