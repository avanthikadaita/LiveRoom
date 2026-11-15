-- Stretch features (spec 11): corner sets and the seller flow. Idempotent.

-- A seller's own item becomes a listing with source 'FitCheck' (inactive until the seller publishes it),
-- so it goes through the same cutout -> 3D -> export pipeline as scraped listings.
alter table listings drop constraint if exists listings_source_check;
alter table listings add constraint listings_source_check
  check (source in ('fb_marketplace', 'craigslist', 'ebay', 'FitCheck'));

-- ---------------------------------------------------------------- corner sets
-- The web app (or the Mastra furnishCorner workflow) inserts a set with status 'pending' and its items;
-- the worker's `sets` stage arranges them, exports one USDZ and fills in the URLs.
alter table sets add column if not exists status text not null default 'pending';
alter table sets add column if not exists prompt text;            -- e.g. "study corner under $60"
alter table sets add column if not exists error text;
alter table sets add column if not exists file_bytes int;
alter table sets add column if not exists w_in numeric(6,1);      -- footprint of the whole arrangement
alter table sets add column if not exists d_in numeric(6,1);
alter table sets add column if not exists h_in numeric(6,1);
alter table sets add column if not exists updated_at timestamptz not null default now();
alter table sets drop constraint if exists sets_status_check;
alter table sets add constraint sets_status_check check (status in ('pending', 'exporting', 'ready', 'failed'));
alter table set_items add column if not exists pos int not null default 0;          -- order the user picked
alter table set_items add column if not exists placed boolean not null default false; -- true once the worker arranged it
create index if not exists sets_status on sets (status, updated_at);

-- ---------------------------------------------------------------- seller flow
-- The web app uploads the photo to Blob and inserts a draft. The worker's `seller` stage tags it with Gemini,
-- takes the seller's measured height as the true height, suggests a fair price from comparable scraped
-- listings, and queues real 3D for it. Progress = the draft's status + the asset's status / asset_events.
create table if not exists seller_drafts (
  id             bigserial primary key,
  listing_id     bigint references listings(id) on delete set null,
  photo_url      text not null,                  -- hosted https (Blob)
  height_in      numeric(6,1) not null check (height_in > 0 and height_in < 120),
  title          text,
  ask_usd        numeric(10,2),
  city           text,                           -- neighbourhood or city, never an address
  lat            double precision,
  lng            double precision,
  status         text not null default 'new' check (status in ('new', 'processing', 'ready', 'failed')),
  category       text,
  fair_price_usd numeric(10,2),
  fair_low_usd   numeric(10,2),
  fair_high_usd  numeric(10,2),
  comps_n        int,
  comp_urls      text[] not null default '{}',
  error          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists seller_drafts_status on seller_drafts (status, created_at);

-- the /sell page keeps this secret; only its holder may publish the draft
alter table seller_drafts add column if not exists edit_token text;
