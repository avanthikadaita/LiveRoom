// Per-shopper math shared by the SQL path (card shaping) and the offline snapshot path
// (full filter + rank in TypeScript when Neon is unreachable in DEMO_MODE).
import { buildArHref } from '../logic/arHref';
import { carFit, type Car, type Fit } from '../logic/carFit';
import {
  CITY_ONLY_MIN_RADIUS_MI, WALK_MAX_LB, WALK_MAX_MI, driveMinutes, isPreciseLocation, hoursAgo, maxRoadMiles, pickupCost, roadMiles, savingsVsNew,
} from '../logic/cost';
import type { Origin } from '../logic/geo';
import type { SearchArgs } from './schema';
import type { Card, RawItem } from './types';

export const RESULT_LIMIT = 8;
export const DEMO_PIN_BOOST = 0.15;
/** A model made from the listing's own photos beats a generic stand-in of similar relevance. */
export const REAL_MODEL_BOOST = 0.25;
export const TOO_BIG_PENALTY = 0.25;

export function styleWords(style_text: string | null | undefined): string[] {
  return [...new Set((style_text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))].slice(0, 8);
}

type Computed = {
  mode: Card['mode']; total: number; extra: number; road_mi: number | null;
  car_fit: Fit | null; car_name: string | null; score: number;
};

export function toCard(r: RawItem, c: Computed, now = new Date()): Card {
  // Only a model built from this listing's own photos counts. A generic stand-in never poses as the item in 3D/AR.
  const hasModel = !!r.usdz_url && r.asset_status === 'ready' && !r.is_approx_model;
  const dimsApprox =
    r.dims_source !== 'listing_text' ||
    (r.listed_w != null && r.w != null && Math.abs(r.listed_w - r.w) > 2) ||
    (r.listed_d != null && r.d != null && Math.abs(r.listed_d - r.d) > 2);
  const photo = r.photo_urls?.[r.best_photo_idx] ?? r.photo_urls?.[0] ?? null;
  const locPrecise = r.loc_precise ?? isPreciseLocation(r.city, r.lat);
  const card: Card = {
    id: Number(r.id), source: r.source, url: r.url, title: r.title, photo,
    category: r.category, style_tags: r.style_tags ?? [], condition: r.condition, summary: r.summary,
    price_usd: r.price, shipping_usd: r.shipping, ships: r.ships,
    mode: c.mode, total_usd: c.total, extra_usd: c.extra,
    road_mi: c.road_mi == null ? null : Math.round(c.road_mi * 10) / 10,
    drive_min: c.road_mi == null ? null : driveMinutes(c.road_mi),
    loc_precise: locPrecise,
    city: r.city, w_in: r.w, d_in: r.d, h_in: r.h, dims_approx: dimsApprox, weight_lb_est: r.weight_lb,
    has_model: hasModel, asset_status: r.asset_status, is_approx_model: !!r.is_approx_model,
    glb_url: r.glb_url, usdz_url: r.usdz_url, ar_href: null,
    baseline_usd: r.baseline_usd, savings_usd: savingsVsNew(r.baseline_usd, c.total),
    car_fit: c.car_fit, car_name: c.car_name,
    scraped_at: new Date(r.scraped_at).toISOString(), found_ago: hoursAgo(r.scraped_at, now),
    is_active: r.is_active, demo_pin: r.demo_pin, score: Math.round(c.score * 1000) / 1000,
  };
  if (hasModel) {
    card.ar_href = buildArHref({
      usdz_url: r.usdz_url!, title: r.title, price_usd: r.price, mode: c.mode,
      road_mi: card.road_mi, shipping_usd: r.shipping, condition: r.condition,
    });
  }
  return card;
}

/** Cost options for one item and one shopper. Returns null when the item is not reachable for them. */
export function costFor(r: RawItem, f: SearchArgs, origin: Origin, fuel: number) {
  const road =
    r.lat == null || r.lng == null || r.source === 'ebay' ? null : roadMiles(origin.lat, origin.lng, r.lat, r.lng);
  let pickup: number | null = null;
  if (road != null && !f.ships_only) {
    if (!f.has_car) {
      if (road <= WALK_MAX_MI && (r.weight_lb ?? 999) <= WALK_MAX_LB) pickup = r.price;
    } else if (road <= maxRoadMiles(f) || (!(r.loc_precise ?? isPreciseLocation(r.city, r.lat)) && maxRoadMiles(f) >= CITY_ONLY_MIN_RADIUS_MI)) pickup = Math.round((r.price + pickupCost(road, fuel)) * 100) / 100;
  }
  const ship = r.ships && (f.ships_ok || f.ships_only) ? r.price + (r.shipping ?? 0) : null;
  if (pickup == null && ship == null) return null;
  const useShip = ship != null && (pickup == null || ship < pickup);
  const total = useShip ? ship! : pickup!;
  return {
    road_mi: road,
    total,
    mode: (useShip ? 'ship' : f.has_car ? 'pickup' : 'walk') as Card['mode'],
    extra: Math.round((total - r.price) * 100) / 100,
  };
}

/** Full filter + rank in TypeScript. Mirrors lib/search/sql.ts; used for the offline snapshot. */
export function evaluate(
  items: RawItem[], f: SearchArgs, origin: Origin, cars: Car[], fuel: number,
  opts: { requireModel?: boolean; limit?: number; now?: Date } = {},
): Card[] {
  const words = styleWords(f.style_text);
  const car = f.car_make_model && f.has_car
    ? cars.find((c) => c.make_model.toLowerCase() === f.car_make_model!.toLowerCase()) ??
      cars.find((c) => c.make_model.toLowerCase().includes(f.car_make_model!.toLowerCase()) ||
        f.car_make_model!.toLowerCase().includes(c.make_model.toLowerCase().replace(/^\S+\s+/, ''))) ?? null
    : null;
  const pool = items
    .filter((r) => r.is_active && r.price != null)
    .filter((r) => (opts.requireModel ?? true) ? r.asset_status === 'ready' || r.asset_status === 'fallback_ready' : true)
    .filter((r) => !f.categories.length || (f.categories as string[]).includes(r.category))
    .filter((r) => !f.free_only || r.price === 0)
    .filter((r) => (f.max_w_in == null || (r.w ?? 0) <= f.max_w_in) && (f.max_d_in == null || (r.d ?? 0) <= f.max_d_in) && (f.max_h_in == null || (r.h ?? 0) <= f.max_h_in))
    .map((r) => ({ r, c: costFor(r, f, origin, fuel) }))
    .filter((x): x is { r: RawItem; c: NonNullable<ReturnType<typeof costFor>> } => x.c != null)
    .filter((x) => f.max_total_usd == null || x.c.total <= f.max_total_usd);
  const maxTotal = Math.max(0, ...pool.map((x) => x.c.total));
  const scored = pool.map(({ r, c }) => {
    const hay = `${r.title} ${(r.style_tags ?? []).join(' ')} ${r.summary ?? ''}`.toLowerCase();
    const sim = words.length ? words.filter((w) => hay.includes(w)).length / words.length : 0;
    const fit = car && r.w && r.d && r.h ? carFit({ w: r.w, d: r.d, h: r.h }, car) : null;
    const score =
      0.6 * sim + 0.4 * (1 - (maxTotal > 0 ? c.total / maxTotal : 0)) +
      (r.demo_pin ? DEMO_PIN_BOOST : 0) + (r.asset_status === 'ready' && !r.is_approx_model ? REAL_MODEL_BOOST : 0) - (fit === 'too_big' ? TOO_BIG_PENALTY : 0);
    return { r, c: { ...c, car_fit: fit, car_name: car?.make_model ?? null, score } };
  });
  scored.sort((a, b) => b.c.score - a.c.score || a.r.id - b.r.id);
  let ordered = scored;
  if (f.categories.length > 1) {
    // round-robin by category so "lamp and side table" shows both
    const rank = new Map<string, number>();
    ordered = scored
      .map((x) => { const n = (rank.get(x.r.category) ?? 0) + 1; rank.set(x.r.category, n); return { x, n }; })
      .sort((a, b) => a.n - b.n || b.x.c.score - a.x.c.score || a.x.r.id - b.x.r.id)
      .map((y) => y.x);
  }
  return ordered.slice(0, opts.limit ?? RESULT_LIMIT).map(({ r, c }) => toCard(r, c, opts.now));
}
