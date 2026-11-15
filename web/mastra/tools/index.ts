// Typed Mastra tools for the FitCheckShopper agent. Each one wraps a tested module from /lib,
// has a timeout through the underlying client, and returns a small result the model can read.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { query, readBranch } from '@/lib/db';
import { env } from '@/lib/env';
import { logError } from '@/lib/errors';
import { CATEGORIES } from '@/lib/logic/categories';
import { carFit, matchCar } from '@/lib/logic/carFit';
import { savingsVsNew } from '@/lib/logic/cost';
import { resolveOrigin } from '@/lib/logic/geo';
import { executeSearch, type Executed } from '@/lib/search/run';
import { parseSearchArgs, type SearchArgs } from '@/lib/search/schema';
import { fetchCars, fetchRawItems } from '@/lib/search/sql';
import { verifyStillListed } from '@/lib/verifyListing';

/** Per-request scratch space the route reads after the agent finishes. */
export type AgentStash = {
  coords: { lat: number; lng: number } | null;
  filters?: SearchArgs;
  executed?: Executed;
};
const stashOf = (ctx: any): AgentStash => {
  const rc = ctx?.requestContext;
  let s = rc?.get?.('stash') as AgentStash | undefined;
  if (!s) { s = { coords: null }; rc?.set?.('stash', s); }
  return s;
};

export const resolveOriginTool = createTool({
  id: 'resolveOrigin',
  description: 'Resolve where the shopper is from a place name or ZIP they said. Falls back to browser location, then UCSD.',
  inputSchema: z.object({ place_text: z.string().optional().describe('e.g. "Pepper Canyon" or "92122"') }),
  outputSchema: z.object({ label: z.string(), lat: z.number(), lng: z.number(), source: z.string() }),
  execute: async ({ place_text }, ctx) => {
    const o = resolveOrigin({ origin_text: place_text, coords: stashOf(ctx).coords }, { lat: env.ORIGIN_LAT, lng: env.ORIGIN_LNG });
    return { label: o.label, lat: o.lat, lng: o.lng, source: o.source };
  },
});

export const searchListingsTool = createTool({
  id: 'searchListings',
  description:
    'Search used furniture near San Diego with one hybrid SQL query (filters + style similarity + cost ranking). ' +
    'Call exactly once per shopper message with everything they asked for, including what you remember about them.',
  inputSchema: z.object({
    categories: z.array(z.enum(CATEGORIES)).describe('"lamp" alone = desk_lamp + floor_lamp; "table" alone = side_table + coffee_table'),
    max_total_usd: z.number().nullish().describe('budget ceiling in USD'),
    max_distance_mi: z.number().nullish(),
    max_drive_min: z.number().nullish(),
    ships_ok: z.boolean().nullish().describe('false only if they refuse shipping'),
    ships_only: z.boolean().nullish().describe('true if they only want shipped or delivered items'),
    free_only: z.boolean().nullish(),
    style_text: z.string().nullish().describe('look, material, color: "warm wood", "mid-century"'),
    max_w_in: z.number().nullish(), max_d_in: z.number().nullish(), max_h_in: z.number().nullish(),
    car_make_model: z.string().nullish().describe('e.g. "Honda Civic"'),
    has_car: z.boolean().nullish().describe('false when they have no car, walk, bike or bus'),
    origin_text: z.string().nullish().describe('place or ZIP they said they are near'),
  }),
  outputSchema: z.object({
    count: z.number(),
    origin: z.string(),
    results: z.array(z.object({
      id: z.number(), title: z.string(), category: z.string(), total_usd: z.number(), mode: z.string(),
      road_mi: z.number().nullable(), savings_usd: z.number().nullable(), car_fit: z.string().nullable(),
    })),
  }),
  execute: async (input, ctx) => {
    const stash = stashOf(ctx);
    const filters = parseSearchArgs(input);
    const executed = await executeSearch(filters, stash.coords);
    stash.filters = filters;
    stash.executed = executed;
    return {
      count: executed.results.length,
      origin: executed.origin.label,
      results: executed.results.map((c) => ({
        id: c.id, title: c.title, category: c.category, total_usd: c.total_usd, mode: c.mode,
        road_mi: c.road_mi, savings_usd: c.savings_usd, car_fit: c.car_fit,
      })),
    };
  },
});

export const checkCarFitTool = createTool({
  id: 'checkCarFit',
  description: 'Check whether specific listings fit in a car (estimate from cargo opening and depth). Use for follow-ups like "would it fit in a RAV4?".',
  inputSchema: z.object({ listing_ids: z.array(z.number()).min(1).max(8), car: z.string() }),
  outputSchema: z.object({
    car: z.string().nullable(),
    known_car: z.boolean(),
    fits: z.array(z.object({ id: z.number(), title: z.string(), fit: z.string() })),
  }),
  execute: async ({ listing_ids, car }) => {
    const [cars, items] = await Promise.all([fetchCars(), fetchRawItems(listing_ids)]);
    const c = matchCar(car, cars);
    if (!c) return { car: null, known_car: false, fits: [] };
    return {
      car: c.make_model, known_car: true,
      fits: items.map((i) => ({
        id: i.id, title: i.title,
        fit: i.w && i.d && i.h ? carFit({ w: i.w, d: i.d, h: i.h }, c) : 'unknown',
      })),
    };
  },
});

export const compareToNewTool = createTool({
  id: 'compareToNew',
  description: 'Compare a listing to the median new price on Amazon for its category (estimate).',
  inputSchema: z.object({ listing_id: z.number() }),
  outputSchema: z.object({
    found: z.boolean(), title: z.string().nullable(), price_usd: z.number().nullable(),
    new_median_usd: z.number().nullable(), savings_usd_est: z.number().nullable(),
  }),
  execute: async ({ listing_id }) => {
    const [i] = await fetchRawItems([listing_id]);
    if (!i) return { found: false, title: null, price_usd: null, new_median_usd: null, savings_usd_est: null };
    const total = i.price + (i.ships ? (i.shipping ?? 0) : 0);
    return { found: true, title: i.title, price_usd: i.price, new_median_usd: i.baseline_usd, savings_usd_est: savingsVsNew(i.baseline_usd, total) };
  },
});

export const verifyStillListedTool = createTool({
  id: 'verifyStillListed',
  description: 'Fetch the live listing page (Bright Data) to check it is still up. Only for the single top result, and only when the shopper is about to go get it.',
  inputSchema: z.object({ listing_id: z.number() }),
  outputSchema: z.object({ status: z.enum(['listed', 'gone', 'unchecked']), note: z.string() }),
  execute: async ({ listing_id }) => {
    try {
      const rows = await query<{ url: string }>('select url from listings where id = $1', [listing_id], { branch: readBranch() });
      if (!rows[0]) return { status: 'unchecked' as const, note: 'listing not found' };
      return await verifyStillListed(listing_id, rows[0].url);
    } catch (e) {
      logError('agent.verifyStillListed', e, { listing_id });
      return { status: 'unchecked' as const, note: 'could not check right now' };
    }
  },
});

export const shopperTools = {
  resolveOrigin: resolveOriginTool,
  searchListings: searchListingsTool,
  checkCarFit: checkCarFitTool,
  compareToNew: compareToNewTool,
  verifyStillListed: verifyStillListedTool,
};
