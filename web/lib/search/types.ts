import type { Fit } from '../logic/carFit';
import type { Origin } from '../logic/geo';
import type { SearchArgs } from './schema';

/** A listing joined with its details, asset and baseline, before any per-shopper math. */
export type RawItem = {
  id: number;
  source: 'fb_marketplace' | 'craigslist' | 'ebay' | 'FitCheck';
  url: string;
  title: string;
  price: number;
  shipping: number | null;
  ships: boolean;
  city: string | null;
  lat: number | null;
  lng: number | null;
  photo_urls: string[];
  best_photo_idx: number;
  scraped_at: string;
  is_active: boolean;
  demo_pin: boolean;
  category: string;
  style_tags: string[];
  condition: string | null;
  dims_source: 'listing_text' | 'estimated';
  weight_lb: number | null;
  summary: string | null;
  w: number | null; d: number | null; h: number | null; // final (exported) dims when known
  listed_w: number | null; listed_d: number | null;
  asset_status: string | null;
  glb_url: string | null;
  usdz_url: string | null;
  is_approx_model: boolean;
  baseline_usd: number | null;
  /** from SQL; computed from city when missing (snapshot) */
  loc_precise?: boolean;
};

export type Card = {
  id: number;
  source: RawItem['source'];
  url: string;
  title: string;
  photo: string | null;
  category: string;
  style_tags: string[];
  condition: string | null;
  summary: string | null;
  price_usd: number;
  shipping_usd: number | null;
  ships: boolean;
  mode: 'ship' | 'pickup' | 'walk';
  total_usd: number;
  extra_usd: number; // shipping or estimated gas
  road_mi: number | null;
  drive_min: number | null;
  /** false: the listing only says "San Diego", so road_mi/drive_min are rough (from the city centre) */
  loc_precise: boolean;
  city: string | null;
  w_in: number | null; d_in: number | null; h_in: number | null;
  dims_approx: boolean;
  weight_lb_est: number | null;
  has_model: boolean;
  asset_status: string | null;
  is_approx_model: boolean;
  glb_url: string | null;
  usdz_url: string | null;
  ar_href: string | null;
  baseline_usd: number | null;
  savings_usd: number | null;
  car_fit: Fit | null;
  car_name: string | null;
  scraped_at: string;
  found_ago: string;
  is_active: boolean;
  demo_pin: boolean;
  score: number;
};

export type Profile = {
  location: string;
  car: string | null;
  has_car: boolean;
  budget_usd: number | null;
  style: string | null;
  max_drive_min: number | null;
};

export type WidenChip = { label: string; override: Partial<SearchArgs> };

export type SearchResponse = {
  query: string;
  filters: SearchArgs;
  results: Card[];
  spoken_summary: string;
  profile: Profile;
  origin: Origin;
  engine: 'agent' | 'gemini' | 'keyword';
  /** true when a car was mentioned but is not in the cars table */
  car_unknown: boolean;
  empty_message: string | null;
  widen: WidenChip[];
  /** 'live' from Neon, 'snapshot' when the database was unreachable in DEMO_MODE */
  data_source: 'live' | 'snapshot';
  latency_ms: number;
  assistant_text?: string | null;
};
