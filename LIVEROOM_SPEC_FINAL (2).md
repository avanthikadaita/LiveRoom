# LiveRoom: Build Spec for Claude Code

Read this whole file before writing code. It is the source of truth for scope, architecture, accounts, known pitfalls and tests. When an external API detail here conflicts with that provider's current docs, the docs win: check them first and note the difference in `NOTES.md`.

---

## 0. Ground rules

- **Hackathon:** SanD Hacks (UCSD), Nov 14 to 15, 2026. **No git commits before Sat 10:30am or after Sun 12:00 noon.** Create the repo and make the first commit after 10:30am Saturday.
- **Judging:** science-fair format, Sun 12:30 to 2:30pm. Each judge gets 3 min of pitch and demo, then 2 min of questions. Criteria: Idea, Demo, Technical Complexity, Completion.
- **Priority order:** (1) the demo works 10 out of 10 times, (2) the buyer flow is complete end to end, (3) sponsor integrations are visible and real, (4) stretch features.
- **Never block the demo on a live external call** that can be slow or rate-limited (scraping, 3D generation). Those run in the background pipeline. The demo reads from Neon.
- Every number shown to users that is estimated (dimensions, weight, pickup cost, car fit) must carry an "approx" or "estimate" label.

## 1. Product

**One-liner:** Amazon shows you new furniture in your room. LiveRoom does it for anything on Craigslist.

**Buyer flow (build this first, it is the MVP):**
1. The user opens the site in iPhone Safari, taps the mic, and says: "desk lamp and side table under $40, warm wood, I drive a Civic."
2. Speech goes to text (ElevenLabs), then Gemini turns the text into a structured search (function calling).
3. A hybrid search runs in Neon: SQL filters (category, price, distance, dimension fit) plus pgvector style similarity.
4. Result cards show: photo, total cost (price + shipping, or price + estimated pickup cost), distance or delivery, real dimensions (or "approx"), savings vs. new (Amazon baseline), and a car-fit badge.
5. Tapping **"See it in your room"** opens AR Quick Look with the real listing item at true scale. A banner inside AR shows the price and a "View listing" button.
6. A spoken reply (ElevenLabs TTS): "Found 3 lamps under $30. The closest is free, 1.2 miles away."
7. Each item has a QR code, so a judge can open it on their own phone.

**Supporting screens:** a Pipeline board (live from Neon) and an Impact dashboard.

**Stretch (only after the buyer flow passes every acceptance test):** (a) corner sets, meaning several items in one arranged AR file; (b) the seller flow: photo, then a true-scale 3D listing with a fair-price suggestion and a QR code.

## 2. Accounts and API keys

| Service | Accounts | What to get | Notes |
|---|---|---|---|
| Bright Data | 1 (team) | API token; dataset IDs for Facebook Marketplace, eBay and Amazon scrapers; a Web Unlocker zone for Craigslist | $100 team credit from the event. Store raw results. Async jobs for big batches. |
| Neon | 1 project (owner invites teammates) | `DATABASE_URL` (pooled), `DATABASE_URL_DIRECT`, a `demo` branch connection string | Enable `vector` extension. Event promo credits. |
| Google AI Studio (Gemini) | 1 key per teammate, **each in its own Google Cloud project** (2 to 4 keys) | API keys | Free-tier limits are per project and are no longer published per model. Check each project's limits page in AI Studio. Daily caps reset at midnight Pacific. Team may also add paid credits. |
| ElevenLabs | 1 primary key (1 backup from a teammate) | API key | Creator tier from the event. Used for speech-to-text and text-to-speech. |
| Tripo3D | Each teammate's own account | API key | Image-to-3D, primary provider. Check free credits tonight. |
| Meshy | Each teammate's own account | **No API key on the free plan** (paid plans only; the old shared test key was retired) | Use Meshy **manually** on its website with each person's free credits, then upload the GLB through `/admin`. Only add it to the API chain if the team buys a plan. |
| Hugging Face | Each teammate's own account | Access token | Free ZeroGPU: only a few GPU minutes and about 3 requests per day per account. Quota resets 24h after first use. Tertiary provider. |
| Vercel | 1 | Project + Vercel Blob store token | Hosts the web app and stores 3D files (no credit card needed). |
| Vultr | none | not available at this event | The worker runs on Person A's laptop (keep it plugged in and awake, including overnight). Skip the Vultr track. |
| GoDaddy Registry | 1 | Domain via MLH code | Point it at Vercel. |

Each teammate uses **their own** account for per-person providers. Do not create extra fake accounts to get around free limits. That breaks provider terms.

### Environment variables

`/web/.env.local` and the Vercel project:
```
DATABASE_URL=            # Neon pooled, main branch
DATABASE_URL_DEMO=       # Neon pooled, demo branch
DEMO_MODE=1              # 1 = web app reads from DATABASE_URL_DEMO
GEMINI_API_KEYS=key1,key2,key3      # rotation order
GEMINI_MODEL_FAST=       # current Flash-Lite model id from AI Studio
GEMINI_MODEL_VISION=     # current Flash model id
GEMINI_EMBED_MODEL=      # current Gemini embedding model id
EMBED_DIM=768
ELEVENLABS_API_KEY=
ELEVENLABS_STT_MODEL=    # current Scribe model id
ELEVENLABS_TTS_MODEL=    # current low-latency model id (Flash)
ELEVENLABS_VOICE_ID=
BLOB_READ_WRITE_TOKEN=
NEXT_PUBLIC_SITE_URL=    # https://<your domain>
ORIGIN_LAT=32.8801       # UCSD Geisel Library, approx
ORIGIN_LNG=-117.2376
```
`/worker/.env`:
```
DATABASE_URL_DIRECT=
BRIGHTDATA_API_TOKEN=
BD_DATASET_FB_MARKETPLACE=
BD_DATASET_EBAY=
BD_DATASET_AMAZON=
BD_UNLOCKER_ZONE=
GEMINI_API_KEYS=
GEMINI_MODEL_VISION=
GEMINI_EMBED_MODEL=
TRIPO_API_KEYS=k1,k2
MESHY_API_KEYS=          # leave empty unless the team buys a Meshy plan; the chain skips Meshy when empty
HF_TOKENS=t1,t2,t3,t4
HF_SPACE_IMAGE_TO_3D=    # e.g. a TRELLIS or Hunyuan3D space id; verify it is up
BLOB_READ_WRITE_TOKEN=
```
Never expose any key to the browser. Every provider call goes through `/web/app/api/*` routes or the worker.

## 3. Architecture

```
            ┌──────────────── Python worker (Person A's laptop) ────────────────┐
Bright Data → scrape → Neon(listings)                                          │
              Gemini vision tag → listing_details (+ embedding)                │
              select eligible → rembg cutout → image-to-3D (Tripo→Meshy→HF→    │
              generic fallback) → GLB → headless Chromium + three.js:          │
              orient, re-pivot, fix materials, scale → USDZ + GLB → Vercel Blob │
              Amazon baselines (Bright Data) → new_price_baselines              │
            └───────────── all job state lives in Neon (job queue) ───────────┘

iPhone Safari → Next.js on Vercel:
   mic → /api/stt (ElevenLabs) → /api/search (Gemini function call → SQL + pgvector in Neon)
   → cards → <a rel="ar" href="{usdz}#...">  (AR Quick Look, LiDAR placement)
   → /api/tts (ElevenLabs) spoken summary
   /pipeline (live Neon board), /impact (dashboard), /item/[id] (QR target)
```

### Repo layout
```
/web        Next.js (App Router) + TypeScript + Tailwind, deployed to Vercel
/worker     Python 3.11: scraping, tagging, 3D pipeline, exporter driver (runs on Person A's laptop; must work on Windows and macOS)
/worker/exporter   static HTML page + three.js used by headless Chromium
/db         numbered SQL migrations
/scripts    demo_check, seed_demo, branch_demo
/assets/generic    CC0 furniture models (e.g. Kenney furniture kit), one per category
NOTES.md    decisions, API differences found, open issues
```

## 4. Database (Neon Postgres)

Create `/db/001_init.sql`:

```sql
create extension if not exists vector;

create table listings (
  id            bigserial primary key,
  source        text not null check (source in ('fb_marketplace','craigslist','ebay')),
  external_id   text not null,
  url           text not null,
  title         text not null,
  description   text,
  price_usd     numeric(10,2),          -- 0 for free
  shipping_usd  numeric(10,2),          -- null if pickup only
  ships         boolean not null default false,
  city          text,
  lat           double precision,       -- approx for marketplace listings
  lng           double precision,
  photo_urls    text[] not null default '{}',
  raw           jsonb not null,
  scraped_at    timestamptz not null default now(),
  is_active     boolean not null default true,
  demo_pin      boolean not null default false,   -- curated for the demo
  unique (source, external_id)
);

create table listing_details (
  listing_id     bigint primary key references listings(id) on delete cascade,
  category       text not null,          -- see category allowlist
  style_tags     text[] not null default '{}',
  condition      text,                   -- new|like_new|good|fair|poor
  w_in numeric(6,1), d_in numeric(6,1), h_in numeric(6,1),
  dims_source    text not null check (dims_source in ('listing_text','estimated')),
  weight_lb_est  numeric(6,1),
  best_photo_idx int not null default 0,
  photo_ok       boolean not null,       -- single object, clean, mostly in frame
  eligible_3d    boolean not null,
  summary        text,
  embedding      vector(768),
  tagged_at      timestamptz not null default now(),
  model_used     text
);
create index on listing_details using hnsw (embedding vector_cosine_ops);

create type asset_status as enum ('queued','cutout','gen_pending','gen_done','exporting','ready','failed','fallback_ready');

create table assets (
  listing_id   bigint primary key references listings(id) on delete cascade,
  status       asset_status not null default 'queued',
  provider     text,                     -- tripo|meshy|hf|generic
  provider_job text,
  cutout_url   text,
  glb_url      text,
  usdz_url     text,
  is_approx_model boolean not null default false,
  final_w_in numeric(6,1), final_d_in numeric(6,1), final_h_in numeric(6,1),
  attempts     int not null default 0,
  last_error   text,
  locked_by    text,
  locked_at    timestamptz,
  updated_at   timestamptz not null default now()
);
create index on assets (status, updated_at);

create table asset_events (            -- feeds the Pipeline board
  id bigserial primary key,
  listing_id bigint references listings(id) on delete cascade,
  from_status text, to_status text, note text,
  at timestamptz not null default now()
);

create table new_price_baselines (
  category text not null,
  style_key text not null default 'any',
  median_usd numeric(10,2) not null,
  sample_n int not null,
  sample_urls text[] not null,
  fetched_at timestamptz not null default now(),
  primary key (category, style_key)
);

create table provider_usage (           -- shared rate-limit ledger
  provider text not null,               -- gemini:<keyhash>, tripo:<keyhash>, hf:<tokenhash>, brightdata, elevenlabs
  window_start timestamptz not null,
  window_kind text not null check (window_kind in ('minute','day')),
  count int not null default 0,
  primary key (provider, window_kind, window_start)
);

create table provider_state (
  provider text primary key,
  cooldown_until timestamptz,
  first_use_today timestamptz,          -- HF quota resets 24h after first use
  note text
);

create table searches (
  id bigserial primary key,
  query_text text not null,
  filters jsonb not null,
  result_ids bigint[] not null,
  latency_ms int,
  at timestamptz not null default now()
);

create table impact_events (
  id bigserial primary key,
  listing_id bigint references listings(id) on delete cascade,
  kind text not null check (kind in ('ar_view','listing_open')),
  dollars_saved_est numeric(10,2),
  lbs_diverted_est numeric(6,1),
  at timestamptz not null default now()
);

create table cars (                     -- approximate cargo openings for fit checks
  make_model text primary key,
  cargo_w_in numeric(5,1), cargo_h_in numeric(5,1), cargo_d_in numeric(5,1),
  seats_folded_d_in numeric(5,1),
  source_url text not null
);
```

**Job queue pattern** (used by every worker stage):
```sql
update assets set status = 'cutout', locked_by = $1, locked_at = now(), attempts = attempts + 1, updated_at = now()
where listing_id = (
  select listing_id from assets
  where status = 'queued' and (locked_at is null or locked_at < now() - interval '10 minutes')
  order by updated_at limit 1 for update skip locked)
returning listing_id;
```
Every status change also inserts a row in `asset_events`.

**Fixtures vs. real data:** the fake fixture listings exist only so Person B can build early. Delete them (`scripts/drop_fixtures`) before the demo branch is made. Every item shown at judging must be a real scraped listing. `demo_pin` only marks real listings whose 3D model has been checked by a human; it boosts their ranking (+0.15) but never adds fake data.

**Demo branch:** `scripts/branch_demo` creates or refreshes a Neon branch `demo` from `main` (Neon API or console), once demo items are `ready`. With `DEMO_MODE=1` the web app reads from the demo branch while the worker keeps writing to `main`. Document the exact steps in `NOTES.md`.

**Cold starts:** the web app pings `select 1` every 4 minutes during judging (a `/api/health` route plus a client interval on the pipeline page), and `scripts/demo_check` warms it right before judging.

## 5. Shared rate-limit module (build first in the worker; mirror it in the web API routes)

`worker/limits.py` and `web/lib/limits.ts`:
- `acquire(provider, per_minute, per_day)` increments `provider_usage` atomically (upsert on the current minute/day window). It raises `QuotaExceeded` if a cap is hit and returns the key to use.
- **Key rotation:** for multi-key providers, try keys in order and skip any whose `provider_state.cooldown_until > now()`.
- **On 429 or a quota error:** set `cooldown_until` (Gemini daily cap: until next midnight Pacific; Gemini per-minute: 65 s; HF: `first_use_today + 24h`; Tripo/Meshy: as the response says, default 15 min). Retry with exponential backoff plus jitter (1s, 2s, 4s, 8s, max 5 tries), then move on to the next key or provider.
- **Circuit breaker:** after 5 consecutive failures for a provider, open the breaker for 10 minutes.
- **Caching:** never call Gemini twice for the same listing content (hash title + description + first photo URL). Cache TTS audio by text hash in Vercel Blob. Cache the STT nothing (one-off).
- **Config caps** (start conservative, tune after checking each provider's dashboard): Gemini per key 8 req/min for vision, 20 req/min for query parsing; Bright Data trigger at most 1 job per source per 30 min; Tripo/Meshy 1 concurrent job per key; HF 3 requests/day per token.

## 6. Worker pipeline (Python)

Install: `psycopg[binary]`, `httpx`, `google-genai`, `rembg[cpu]`, `pillow`, `gradio_client`, `playwright` (+ `playwright install chromium`), `usd-core`, `tenacity`, `pydantic`, `python-dotenv`, `pytest`.

Run as `python -m worker.run --stages scrape,tag,select,cutout,gen,export,baseline --loop`. Each stage processes a small batch and returns, so a stalled provider never blocks the others.

### 6.1 Scrape (Bright Data)
- **Facebook Marketplace:** Bright Data's Marketplace scraper (discover by keyword + location). Keywords: `side table, nightstand, desk lamp, floor lamp, stool, accent chair, dresser, bookshelf, ottoman, coffee table`. Location: San Diego / La Jolla.
- **eBay:** Bright Data eBay scraper, used condition, ships to 92093, same keywords. Fill `shipping_usd`, `ships=true`.
- **Craigslist San Diego:** Web Unlocker fetch of the furniture search pages (by-owner and free sections), then parse the HTML. If parsing is fragile, use Bright Data's AI Scraper Studio to build a Craigslist scraper instead, and write down which approach you used in `NOTES.md`.
- **API flow** (verify against current Bright Data docs): trigger an async job with the dataset id, poll progress, download the snapshot as JSON. Use synchronous scrape only for 20 URLs or fewer.
- Cap each run at 150 records per source. Upsert on `(source, external_id)` and store the full raw record in `raw`.
- Location: map city or neighborhood names to approximate coordinates with a small lookup table (`worker/geo_sd.json`, about 40 San Diego area places). Show distances with "~".
- Never store seller names, phone numbers or emails. Keep only the public listing URL.

### 6.2 Tag (Gemini vision)
- Input: title, description, price, and up to 3 photos (pass image URLs or downloaded bytes).
- Output: strict JSON from a schema (use the SDK's structured output):
  `category` (allowlist below or `other`), `style_tags[]`, `condition`, `w_in/d_in/h_in`, `dims_source` (`listing_text` only if the numbers literally appear in the text, else `estimated`), `weight_lb_est`, `best_photo_idx`, `photo_ok` (single object, mostly in frame, not cluttered, not glass or chrome), `summary` (1 line).
- **Category allowlist** (chunky things that image-to-3D handles well): `side_table, nightstand, coffee_table, desk_lamp, floor_lamp, stool, ottoman, accent_chair, dining_chair, dresser, bookshelf, desk`.
- `eligible_3d = category in allowlist and photo_ok`.
- Embedding: embed `summary + style_tags + category` with the Gemini embedding model at `EMBED_DIM`.
- Batch: up to 5 listings per vision request when photos are small, if the model handles it reliably. Otherwise do 1 per request.

### 6.3 Select and cutout
- Queue an asset for every `eligible_3d` listing, ordered by: `demo_pin` first, then ships or distance under 10 miles, then newest.
- Download the best photo, run `rembg` (u2net), crop to the alpha bounding box, pad 10%, and save the PNG to Blob as `cutout_url`.
- Reject cutouts where the alpha area covers under 8% or over 95% of the image (a bad mask). Mark those `failed` with a reason.

### 6.4 Image-to-3D (provider chain)
Order: **Tripo → Meshy (only if `MESHY_API_KEYS` is set) → Hugging Face space → generic fallback**. Hand-made GLBs uploaded through `/admin` (`provider='manual'`) skip generation entirely.
- Wrap every provider behind `generate_glb(cutout_png_url) -> glb_bytes`, with the same timeout (Tripo/Meshy 6 min, HF 4 min) and polling every 5 s.
- Check provider docs for the exact create-task and poll endpoints. Verify the HF space is running and its input format with `gradio_client` before relying on it.
- **HF quota:** with about 3 requests a day per token, track `first_use_today`. Ask teammates to start their HF quota at different times so quotas don't all run out together.
- **Multi-photo mode (try first when it fits):** listings often have 2 to 4 photos. During tagging, have Gemini also return `views`: for each photo, whether it shows the *same object*, its angle (`front`, `side`, `back`, `three_quarter`, `detail`), and whether it's clean. If at least 2 clean, same-object photos from *different* angles exist, cut out each one and call the provider's multi-image endpoint. Tripo and Meshy both advertise multi-view or multi-image to 3D; verify the endpoints and how they expect the views to be labeled. Otherwise use the single best photo. Mixed photos (different rooms, lighting, partial shots, close-up details) make results worse, so never send detail shots or photos of other objects. Store `views_used` on the asset. Compare single- vs multi-photo output on 3 fixtures and record the result in `NOTES.md`.
- **Generic fallback:** if every provider fails or is out of quota, use `/assets/generic/<category>.glb` and set `is_approx_model=true`. The UI then shows the "approx model" label.
- Upload the GLB to Blob and set `glb_url`.

### 6.5 Export (headless Chromium + three.js) — proven approach
**Do NOT** run three.js `USDZExporter` in plain Node: textured models fail there because it needs a canvas. **Do NOT** stitch finished USDZ files together with USD references: three.js writes materials outside the default prim, so referenced items lose their materials. Both were tested and failed.

Use Playwright to open `/worker/exporter/index.html` (three.js 0.170 from a local copy), call `window.exportItem({glbUrl, w_in, d_in, h_in, category})`, and get the bytes back. Inside the page:
1. **Load the GLB** with GLTFLoader.
2. **Fix materials:** set `metalness=0` and `roughness=max(roughness, 0.6)`. If a texture map exists, set `color` to white. Set `side=FrontSide`, since USDZ has no double-sided materials. Reason: glTF's default metallic value is 1, which renders black or like dark chrome in AR.
3. **Auto-orient:** try the 6 orientations (identity, ±90° about X, ±90° about Z, 180° about X). For each one, compute the bounding-box ratio W:D:H and pick the one closest to the listing's dimension ratio. If the dimensions are estimated, use category priors (lamps and bookshelves are tall; tables are roughly as wide as tall).
4. **Re-pivot:** wrap the model in a new group so the origin sits at the footprint center, with the base at y=0. Reason: generated models often have their pivot far from the object, so rotating them swings the item to the wrong place.
5. **Scale uniformly by height** to `h_in` (in meters, 1 in = 0.0254). Then report the final W×D×H. If W or D differs from the listing by more than 2 inches, set `dims_source` back to `estimated` in the UI.
6. **Export** with `USDZExporter.parseAsync(scene, { quickLookCompatible: true })`.

Then in Python:
- Validate with `usd-core` (`pxr.UsdValidation` validators for USDZ and package checks, plus a bounding-box size check within 0.5 in of the final dimensions) before upload.
- Upload to Blob with `contentType: 'model/vnd.usdz+zip'`.
- Set `usdz_url`, `final_*_in`, `status='ready'` (or `fallback_ready`).
- Keep the files under 15 MB, and downscale textures to 1024 px if needed.

### 6.6 New-price baselines (Amazon via Bright Data)
For each category and coarse style, pull the top 10 new Amazon results, take the median price, and store it with sample URLs. Refresh every 24h. Savings = `baseline_median - (price + shipping or pickup estimate)`, floored at 0, labeled "est. vs. new".

## 7. Web app (Next.js + TypeScript + Tailwind)

### API routes
- `POST /api/stt`: receives the audio blob. iOS Safari's MediaRecorder produces `audio/mp4`; confirm ElevenLabs accepts that, and transcode with ffmpeg.wasm only if it doesn't. Calls ElevenLabs speech-to-text and returns `{text}`. Rate limit: 30 per minute per IP.
- `POST /api/search`:
  1. Gemini function calling (fast model) with a `search_listings` tool. Arguments: `categories[]`, `max_total_usd`, `max_distance_mi`, `max_drive_min`, `ships_ok`, `style_text`, `max_w_in/max_d_in/max_h_in`, `car_make_model`, `has_car` (false when the user says they have no car), `origin_text` (a place the user names, e.g. "Pepper Canyon" or a ZIP).
  2. Validate the arguments with zod.
  3. Embed `style_text`.
  4. Run **one SQL query**:
     - joins: `listings`, `listing_details`, `assets` (only `ready` or `fallback_ready`), plus the baseline
     - computes: haversine distance from the origin, total cost
     - filters: price, distance or `ships`, dimensions
     - ranks: `0.6*(1 - cosine_distance) + 0.4*(1 - normalized_total_cost)`
     - limit 8
  5. Log to `searches`. Return cards plus a short `spoken_summary`.
  6. If Gemini is out of quota, fall back to a keyword parser, so search never hard-fails.
- `POST /api/tts`: text in, audio out from ElevenLabs (low-latency model), cached by text hash.
- `POST /api/impact`: records `ar_view` or `listing_open`, with the savings and weight estimate.
- `GET /api/pipeline`: status counts plus the last 30 `asset_events`. **Always reads the `main` branch (`DATABASE_URL`), even in `DEMO_MODE`**, so judges see the worker processing new listings live while search reads the frozen demo branch.
- `GET /api/health`: `select 1`.
- `POST /api/admin/upload-glb` (protected by an `ADMIN_TOKEN` env var): upload a GLB for a listing (made by hand on a provider's website), store it in Blob, set `assets.glb_url`, `provider='manual'`, `status='gen_done'`, so the worker's exporter picks it up. Plus a simple `/admin` page: search listings, see each asset's status, upload a GLB, toggle `demo_pin`, set `orient_override`.

### Pages
Visual design comes from a separate design prompt (Person B pastes it into the web session). This spec only defines behavior and content.

- `/`: hero, mic button (hold to talk, with a text box fallback), results grid. On iOS, the AR link must be **exactly**:
  ```html
  <a rel="ar" href="{usdz_url}#allowsContentScaling=0&callToAction=View%20listing&checkoutTitle={title}&checkoutSubtitle={~1.2 mi · Used}&price={$15}">
    <img src="{thumb}" alt="{title}">
  </a>
  ```
  - The anchor must contain an `<img>` as its first child, and `usdz_url` must be a real hosted https URL. Never use a blob or object URL, because Safari ignores the fragment parameters on those.
  - Listen for the `message` event on that anchor. When `event.data === '_apple_ar_quicklook_button_tapped'`, record `listing_open` and open the listing URL.
  - On non-iOS devices, show a `<model-viewer>` 3D preview from `glb_url` instead.
- **Card contents:**
  - photo
  - title
  - total cost, with "FREE" when the price is 0
  - "~1.2 mi pickup (~$1 gas est.)" or "Ships $9, total $24"
  - dimensions with an "approx" badge if they're estimated
  - "approx model" badge if it's the generic fallback
  - "Saves ~$40 vs. new"
  - car-fit badge when a car was mentioned: ✅ fits / ⚠️ seats folded / ❌ too big
  - buttons: See it in your room, 3D preview, View listing, QR
- `/item/[id]`: the same card, large, with a QR code (`qrcode` package) pointing to this page. The QR target for judges' phones.
- `/pipeline`: live board polling `/api/pipeline` every 3 s. Columns by status, counts, recent transitions, provider health (cooldowns), and the share of real-scale vs. approx models.
- `/impact`: listings indexed this weekend, free items count, total savings available, AR views, estimated pounds kept out of landfill. All labeled as estimates.

### Logic modules (pure functions, unit-tested)
- `carFit(item, car)`: try each item orientation (which side faces the trunk opening). Fits if the item clears the opening width and height and the cargo depth; "seats folded" if it only fits using `seats_folded_d_in`. Populate `cars` with about 15 common models (Civic, Corolla, Camry, Model 3, Model Y, RAV4, CR-V, Prius, Elantra, Mazda3, Outback, Jetta, Accord, Sentra, Wrangler) from published cargo specs. Every row needs a `source_url`, and the UI says "estimate".
- `pickupCost(distance_mi)`: round trip × fuel cost per mile (config, default $0.15), labeled "est."
- `totalCost(listing)`: price + shipping, or price + pickup cost.
- `formatDistance`: "~X.X mi".
- **Origin (where the user is):** in priority order: (1) a place the user says (`origin_text`, looked up in `geo_sd.json`), (2) the browser's location if they allow it (ask only after the first search, round to 2 decimals before sending, never store it), (3) UCSD as the default. Always show the origin on the results ("From Pepper Canyon, change") so the user can fix it.
- **Distance and drive time:** straight-line (haversine) distance × 1.3 road factor, and drive time at an average 25 mph. Both labeled "est." No routing API (it adds a key, limits and latency for little gain at this scale).
- **Distance filter:** `max_drive_min` wins if given, else `max_distance_mi`, else default 10 miles. Shipped items always pass the distance filter.
- **Listing location:** marketplace locations are approximate (city or neighborhood level), so distances always show "~". eBay items have no pickup distance; they show shipping time instead.
- **No car (`has_car=false`):** only show items that ship, or are within 1 mile and light enough to carry (weight estimate 15 lb or less, labeled "walkable pickup"). Never show a car-fit badge in this mode.
- **Car fit:** per item, using the item's box dims vs. the car's opening and cargo depth (seats up, then seats folded), trying all 3 orientations. If a mentioned car isn't in `cars`, show "Couldn't check your car" instead of guessing. Items that won't fit in the user's car still appear, ranked lower, with "Too big for your Civic, ships for $X" if a shipping option exists.

### Mobile debugging (devs are on Windows)
Load Eruda (an on-page console) only when `?debug=1` is in the URL. Test on the iPhone through a free Cloudflare Tunnel or Vercel preview URLs, since the mic needs HTTPS.

## 8. Known pitfalls (all found during planning; handle every one)

1. Free Hugging Face image-to-3D is about 3 requests per day per account, and the quota resets 24h after first use. Treat HF as the last provider and never rely on it during the demo.
2. Gemini free-tier limits are per project and change; Google stopped publishing per-model numbers. Daily caps reset at midnight Pacific. Rotate keys from separate projects, cache aggressively, and fall back to keyword parsing.
3. For Bright Data batches over 20 URLs, use async trigger, poll and download. Never scrape while a judge is waiting.
4. AR Quick Look ignores URL fragment parameters for blob URLs. Always use hosted https USDZ URLs, served with `model/vnd.usdz+zip`.
5. `allowsContentScaling=0` reportedly doesn't always stop pinch-to-zoom. Test it. If it doesn't hold, the pitch says "don't pinch, it's at true size," and dimensions are shown on the card.
6. AR Quick Look shows one file per session. Multi-item scenes must be composed into one file before export (stretch).
7. three.js `USDZExporter` in Node can't handle textures. Use headless Chromium.
8. Composing finished USDZ files with USD references drops materials. Compose in three.js and export once.
9. glTF's default metallic value is 1, which renders black or chrome. Force metalness to 0.
10. Generated models have pivots far from the object, which breaks rotation and placement. Always re-pivot.
11. USDZ has no double-sided materials. Thin open surfaces like lamp shades vanish from one side. Prefer closed meshes, or accept it.
12. Generated models are often lying sideways or upside down. Use the auto-orient step, and add a manual override field `assets.orient_override` editable from an admin page.
13. Neon cold start: warm it before judging (`/api/health` and `demo_check`).
14. Mic needs HTTPS. iOS records `audio/mp4`.
15. Campus wifi often blocks AirPlay. For a big screen, use a Mac with a USB cable and QuickTime "New Movie Recording" with the iPhone as the source.
16. Image-to-3D is weak on thin parts, glass, chrome and cluttered photos, and the back side is always invented. That's why the category allowlist and `photo_ok` gating exist.
17. Listings sell. Show "found X hrs ago" and mark items inactive if the URL returns gone.

## 9. Tests (must all pass before the demo freeze)

- **Unit (pytest):**
  - re-pivot and scale math, auto-orientation choice on fixtures with known ratios
  - `limits.acquire` windows, cooldown and rotation (mock clock)
  - Gemini JSON validation, with rejection of `dims_source=listing_text` when the numbers aren't in the text
  - Bright Data record normalization for each source
- **Unit (vitest):** `carFit`, `pickupCost`, `totalCost`, the search-argument zod schema, keyword-parser fallback, the AR href builder (exact fragment format).
- **Exporter test (pytest + Playwright):**
  - build a deliberately messy textured GLB fixture (off-center, wrong units, lying sideways, metallic=1)
  - export it, then assert: USD validators report 0 errors; size matches the target within 0.5 in; base at y = 0; texture present in the package; `metallic = 0`
- **Integration:** run the full worker pipeline on 3 fixture listings with providers mocked (recorded responses) and the database on a Neon test branch, ending with assets `ready`.
- **E2E (Playwright, iPhone 14 emulation):** type a search, see cards, check that the AR anchor has `rel="ar"`, a first child `<img>`, an https `.usdz` href and the exact fragment; `/item/[id]` renders a QR; `/pipeline` updates.
- **`scripts/demo_check`** (run before judging, prints PASS or FAIL per line):
  - both database branches reachable
  - at least 8 `demo_pin` items `ready` with real models
  - every demo USDZ URL returns 200 with the correct content type
  - `/api/stt` and `/api/tts` round trip
  - `/api/search` returns results for the 3 rehearsed demo queries in under 3 s

## 10. Build order with checkpoints

| When | Goal | Acceptance |
|---|---|---|
| Sat 10:30 to 12:00 | Repo, Neon schema, limits module, web skeleton deployed, one hand-made USDZ opening in AR from a hosted URL on the iPhone | AR test passes on device |
| 12:00 to 15:00 | Scrape (Marketplace + eBay), Gemini tagging and embeddings, search API returning real listings from typed queries | 100+ tagged listings in Neon |
| 15:00 to 19:00 | Cutout, Tripo/Meshy generation, exporter, upload. First 5 real items `ready`. Cards with AR buttons. | Real listing item at true size in AR on the iPhone |
| 19:00 to 21:00 | Mic and spoken reply, car fit, baselines and savings, pipeline board, impact page, QR pages | Full buyer flow by voice |
| Sat night | Curate 10 to 12 `demo_pin` items, use the remaining provider quotas, generic fallback for the rest, Craigslist source, demo branch | `demo_check` passes |
| Sun 7:00 to 9:30 | Bug fixes only, UI polish, rehearse the demo 10 times, record the backup video | 10/10 runs |
| Sun 9:30 to 11:00 | 3-min submission video, Devpost write-up, placeholder submission by 11:00 | Submitted |
| Sun 11:00 to 12:00 | Small fixes only. Final submit before noon. No commits after. | Done |

**Parallel work:** see section 13.

## 11. Stretch features (only after section 9 is green)

1. **Corner sets:** compose 2 or 3 ready items in the exporter page (wrap each in a pivot group, place the lamp at the table's height, rotate the chair), export one USDZ, store it in `sets` and `set_items` tables, and add a "See the whole corner" button.
2. **Seller flow:** camera photo, height input, cutout, generation, export, then a listing page with a QR code and a fair-price suggestion (median of Bright Data comparables). Show a progress UI while it works, and pre-generate the demo object that morning as backup.
3. **Paste any listing link:** synchronous Bright Data fetch of one URL, then the pipeline with a progress bar. Demo only if provider quota remains.

## 12. Demo script (for the README and rehearsal)

1. "Americans landfill about 12 million tons of furniture a year. Students still buy new, because used listings are a gamble."
2. Hand the judge the phone. They say: "desk lamp and side table under $40, warm wood, I drive a Civic."
3. Cards appear. The spoken reply plays. Point out the free lamp 1.2 miles away and the shipped side table that saves about $40.
4. Tap "See it in your room." The real listing lamp sits on our table at true size. The judge walks around it.
5. The judge scans the QR on their own phone and sees it on theirs.
6. Flash the pipeline board: "This runs live on Neon. A Postgres job queue drives scraping, tagging and 3D generation."
7. Answer for "Amazon already does AR": "They only do it for their own catalog, where they built 3D models ahead of time. Used listings have no 3D models. We make them from the listing photo, at real size."

## 13. Two-person split (no waiting on each other)

The **database is the contract.** The worker only writes to Neon, and the web app only reads Neon (plus `impact_events` and `searches` writes). The two never call each other, so they can be built fully in parallel in separate folders with no merge conflicts.

**Hour 0 handshake (Sat 10:30 to 11:15, both people):**
1. Person A creates the repo, `/db/001_init.sql`, and runs it on Neon `main`.
2. Person A adds `/db/002_fixtures.sql`: 12 realistic fake listings across sources and categories with full `listing_details` (dims, embeddings can be zero vectors at first), 3 of them `assets.status='ready'` pointing at hosted sample USDZ files, 9 others in various statuses, 3 cars, 4 baselines, and a few `asset_events`. Upload the three sample USDZ files (side table, lamp, chair from the reference kit) to Vercel Blob with content type `model/vnd.usdz+zip`.
3. Both share `.env` values through a private channel (never commit them).
From here on, Person B builds against fixtures and never waits for real data.

**Person A: data + 3D (`/worker`, `/db`, `/scripts`)**
1. `limits.py` + tests
2. Bright Data scrape (Marketplace, eBay, then Craigslist) + normalization + tests
3. Gemini tagging + embeddings + photo `views` labeling + tests
4. Cutout stage, provider chain (Tripo → Meshy → HF → generic), exporter (Playwright + three.js) + the exporter test
5. Amazon baselines, `cars` table with sourced values
6. Demo curation (`demo_pin`), Neon `demo` branch script, `scripts/demo_check`
7. Stretch: corner sets export, seller-flow backend

**Person B: web app (`/web`)**
1. Next.js skeleton on Vercel, `limits.ts`, `/api/health`
2. `/api/search` (Gemini function calling + keyword fallback + the single hybrid SQL) + tests, against fixtures
3. Results UI and the AR anchor (exact format) + on-device AR test using a fixture USDZ
4. `/api/stt`, `/api/tts`, hold-to-talk, spoken summary
5. `carFit`, `pickupCost`, `totalCost` + tests; `/item/[id]` with QR
6. `/pipeline` board, `/impact` page, `/api/impact`, AR banner tap handler
7. E2E Playwright tests, error states (section 14), polish
8. Stretch: corner-set button, seller-flow UI

**Person C (ChatGPT Plus) and Person D (free tools)** do not write into `/worker` or `/web` core code. They produce data files and assets in `/data` and `/assets`, and use the `/admin` page:
- `/data/cars.csv`: about 15 cars with cargo dimensions and a `source_url` for each row (Person C).
- `/data/geo_sd.json`: about 40 San Diego places with approximate coordinates (Person C).
- `/assets/generic/<category>.glb`: one CC0 model per allowlisted category, base at the origin (Person C).
- Demo listings: Person D picks 10 to 12 listings with clean photos and marks `demo_pin` in `/admin`; Person D and Person C also make GLBs by hand on Tripo, Meshy and Hugging Face websites with their own free credits and upload them through `/admin`.
Person A's Claude Code loads the CSV/JSON files into Neon with a script (`scripts/load_data`).

**Sync points (15 minutes each):** 15:00 (A: first real tagged listings in `main`; B: search working on fixtures, so switch B's env to real data), 19:00 (A: first real `ready` items; B: full voice flow), 23:00 (demo curation together on the iPhone), Sun 8:00 (freeze, rehearsal).

## 14. Error handling (required everywhere)

**Principles**
- Every external call has a timeout (`AbortController` in TS, `httpx` timeouts in Python), a retry policy from `limits` (only for retryable errors: network, 429, 5xx), and a typed error.
- Nothing fails silently: every caught error is logged with context, and anything the user can see turns into a clear message that says what happened and what to do.
- Every feature degrades instead of breaking the page.

**Shared table**
```sql
create table error_log (
  id bigserial primary key, at timestamptz not null default now(),
  where_ text not null,        -- e.g. 'worker.gen.tripo', 'api.search'
  listing_id bigint, code text, message text, detail jsonb
);
```

**Worker**
- Each stage catches per item, so one bad listing never stops the batch.
- On failure: set `assets.status='failed'` with `last_error`, insert `asset_events` and `error_log`.
- Retry failed items up to 3 attempts total with backoff (`attempts` column), then leave them failed (dead-letter). The pipeline board shows them.
- Stale locks (`locked_at` older than 10 minutes) get reclaimed automatically.
- All writes are idempotent: upserts on natural keys, and re-running any stage never duplicates rows or files (Blob paths are deterministic: `usdz/{listing_id}-v{n}.usdz`).
- Provider-specific: 429 or quota → cooldown + next key/provider; a 3D job that times out → mark it, move to the next provider; invalid GLB or exporter validation failure → next provider, then generic fallback; scrape job error → keep the old data and retry next cycle.
- Graceful shutdown on Ctrl-C: finish the current item, release locks.

**Web API**
- Validate every request body with zod and return 400 with `{ "error": { "code", "message" } }` on bad input.
- Consistent error JSON for all routes. Map provider failures to 502 or 503 with a retryable flag. Never leak keys or stack traces.
- Per-IP rate limits on public routes (judges will scan the QR codes); return 429 with a friendly message.

**Feature fallbacks (UI)**
| Failure | What the user sees |
|---|---|
| Mic permission denied or not HTTPS | The text box takes focus with the message "Microphone is off. Type what you need instead." |
| Speech-to-text fails | "Didn't catch that. Try again or type it." The transcript box stays editable. |
| Gemini query parsing fails or is out of quota | Keyword parser runs instead; search still returns results. |
| Search returns nothing | "No matches under $X within Y miles." Plus one-tap chips to widen: raise the budget, include shipped items, any style. |
| Text-to-speech fails | Results show silently. No error shown. |
| Database unreachable | Full-page message "Can't reach listings right now. Retrying…", auto-retry every 3 s, and in `DEMO_MODE` fall back to a bundled JSON snapshot of the demo items. |
| A USDZ link 404s or the device can't do AR | Hide the AR button and show the 3D preview (`model-viewer` from the GLB). |
| Item has no 3D model yet | Card shows "3D model coming" instead of the AR button. |
| Listing gone (sold) | Card shows "May be sold, last seen X hrs ago." |

Plus a Next.js error boundary on every route with a "Reload" action, and loading skeletons that keep the layout steady.

**Tests for errors:** unit tests for retry and cooldown behavior, each provider's error mapping, every fallback in the table above (mock the failing dependency), and an E2E test with the database URL broken that confirms the demo snapshot kicks in.

## 15. Mastra agent (MLH "Best Use of Mastra" track)

The shopping assistant in `/web` is a **Mastra agent** (TypeScript), replacing the single Gemini function call in `/api/search`. Check Mastra's current docs (`mastra.ai/llms.txt`) and Neon's "Mastra + Neon" guide before coding.

**Agent `liveroomShopper`** (model: Gemini via Mastra's model router or an AI SDK Google provider, so the key-rotation from `limits.ts` still applies; cap tool loops at 4 steps per turn):
- Tools (each a typed Mastra tool with zod input/output, timeouts and the section 14 error mapping):
  - `resolveOrigin(place_text | coords)`: uses `geo_sd.json`, browser coords, or UCSD.
  - `searchListings(filters)`: the single hybrid SQL query from section 7.
  - `checkCarFit(listing_ids, car)`: the `carFit` module.
  - `compareToNew(listing_id)`: the Amazon baseline and savings.
  - `verifyStillListed(listing_id)`: a synchronous Bright Data fetch of that one URL. If it's gone, mark `is_active=false` and say so. This is the "takes action in the real world" piece. Only call it for the top result, and cache it for 30 minutes.
- **Memory on Neon:** Mastra `PostgresStore` with `DATABASE_URL`, in a separate `mastra` schema. Use **working memory** for the shopper profile: location, car or no car, budget, style, max drive time. Follow-up turns then work without repeating anything: "cheaper," "what about one that ships," "my roommate has a RAV4." Thread id = per-browser session id, resource id = anonymous user id (cookie). In Next.js dev, keep the `PostgresStore` instance on `globalThis` to survive hot reloads, as Mastra's docs warn.
- **Output contract** (unchanged for the UI): `{ filters, results, spoken_summary, profile }`.
- **Fallback:** if the agent errors or Gemini is out of quota, run the keyword parser plus `searchListings` directly, so search never fails.

**Workflow `furnishCorner`** (stretch, after section 9 is green): one input ("study corner under $60, I drive a Civic") → plan the item list → search each category in parallel → split the budget across items → check that the *combined* items fit the car → return a set for the corner-set exporter. Mastra workflow steps with typed inputs and outputs, retries on the search step.

**Evals:** a dataset of 25 realistic spoken queries (typos, slang, "under forty bucks," "no car," "near Pepper Canyon") with expected filters. Score the agent's filter extraction with Mastra evals and keep the score at 90% or higher before the freeze. Put the score in the README and Devpost.

**Mastra Studio:** run it locally during development to debug agent traces. For the MLH judge, have Studio open on a laptop showing a live trace of the last search (tool calls, memory, timings).

**Ownership:** Person B builds the agent, tools and memory as part of the search step. Person A takes the `furnishCorner` workflow and the evals in `/web/mastra/` once the worker is stable (Saturday evening). It's an isolated folder, so there are no conflicts.