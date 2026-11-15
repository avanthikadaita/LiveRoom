-- FitCheck schema (spec section 4). Idempotent: safe to re-run.
create extension if not exists vector;

create table if not exists listings (
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

create table if not exists listing_details (
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
create index if not exists listing_details_embedding_hnsw on listing_details using hnsw (embedding vector_cosine_ops);

do $$ begin
  create type asset_status as enum ('queued','cutout','gen_pending','gen_done','exporting','ready','failed','fallback_ready');
exception when duplicate_object then null; end $$;

create table if not exists assets (
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
create index if not exists assets_status_updated on assets (status, updated_at);

create table if not exists asset_events (            -- feeds the Pipeline board
  id bigserial primary key,
  listing_id bigint references listings(id) on delete cascade,
  from_status text, to_status text, note text,
  at timestamptz not null default now()
);

create table if not exists new_price_baselines (
  category text not null,
  style_key text not null default 'any',
  median_usd numeric(10,2) not null,
  sample_n int not null,
  sample_urls text[] not null,
  fetched_at timestamptz not null default now(),
  primary key (category, style_key)
);

create table if not exists provider_usage (           -- shared rate-limit ledger
  provider text not null,               -- gemini:<keyhash>, tripo:<keyhash>, hf:<tokenhash>, brightdata, elevenlabs
  window_start timestamptz not null,
  window_kind text not null check (window_kind in ('minute','day')),
  count int not null default 0,
  primary key (provider, window_kind, window_start)
);

create table if not exists provider_state (
  provider text primary key,
  cooldown_until timestamptz,
  first_use_today timestamptz,          -- HF quota resets 24h after first use
  note text
);

create table if not exists searches (
  id bigserial primary key,
  query_text text not null,
  filters jsonb not null,
  result_ids bigint[] not null,
  latency_ms int,
  at timestamptz not null default now()
);

create table if not exists impact_events (
  id bigserial primary key,
  listing_id bigint references listings(id) on delete cascade,
  kind text not null check (kind in ('ar_view','listing_open')),
  dollars_saved_est numeric(10,2),
  lbs_diverted_est numeric(6,1),
  at timestamptz not null default now()
);

create table if not exists cars (                     -- approximate cargo openings for fit checks
  make_model text primary key,
  cargo_w_in numeric(5,1), cargo_h_in numeric(5,1), cargo_d_in numeric(5,1),
  seats_folded_d_in numeric(5,1),
  source_url text not null
);
