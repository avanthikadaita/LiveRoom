import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/lib/db';
import { carFit } from '@/lib/logic/carFit';
import { UCSD } from '@/lib/logic/geo';
import { evaluate } from '@/lib/search/evaluate';
import { keywordParse } from '@/lib/search/keywordParser';
import { parseSearchArgs } from '@/lib/search/schema';
import { fetchCars, fetchRawItems, searchListingsSql } from '@/lib/search/sql';
import { emptyMessage, spokenSummary, widenChips } from '@/lib/search/summary';

const FUEL = 0.15;
const run = (raw: object, emb: number[] | null = null) => searchListingsSql(parseSearchArgs(raw), UCSD, emb, FUEL, { branch: 'main' });

beforeAll(() => {
  process.env.DATABASE_URL = 'pglite://fixtures';
  process.env.DATABASE_URL_DEMO = '';
  process.env.DEMO_MODE = '0';
});

describe('hybrid search SQL (fixture database)', () => {
  it('only returns items whose 3D model is ready', async () => {
    const cards = await run({});
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThanOrEqual(8);
    for (const c of cards) {
      expect(['ready', 'fallback_ready']).toContain(c.asset_status);
      // AR only for a model made from the listing's photos; a generic stand-in is listed without AR
      expect(c.has_model).toBe(c.asset_status === 'ready' && !c.is_approx_model);
      if (c.has_model) expect(c.ar_href).toMatch(/^https:\/\/.+\.usdz#allowsContentScaling=0&callToAction=View%20listing&checkoutTitle=/);
      else expect(c.ar_href).toBeNull();
    }
    expect(cards.some((c) => c.has_model)).toBe(true);
    expect(cards.map((c) => c.id)).not.toContain(9); // exporting
    expect(cards.map((c) => c.id)).not.toContain(12); // failed
  });

  it('the rehearsed demo query returns lamps and a side table, all under budget', async () => {
    const f = keywordParse('desk lamp and side table under $40, warm wood, I drive a Civic');
    const cards = await searchListingsSql(f, UCSD, null, FUEL, { branch: 'main' });
    const cats = new Set(cards.map((c) => c.category));
    expect(cats).toEqual(new Set(['desk_lamp', 'side_table']));
    expect(cards.every((c) => c.total_usd <= 40)).toBe(true);
    expect(cards.slice(0, 2).map((c) => c.category).sort()).toEqual(['desk_lamp', 'side_table']); // round-robin by category
    const lamp = cards.find((c) => c.id === 1)!;
    expect(lamp).toMatchObject({ price_usd: 0, mode: 'pickup', car_fit: 'fits', car_name: 'Honda Civic', savings_usd: 32 });
    expect(lamp.road_mi).toBeGreaterThan(0.5);
    expect(lamp.road_mi).toBeLessThan(2);
    expect(lamp.total_usd).toBeCloseTo(lamp.road_mi! * 2 * FUEL, 1);
    const table = cards.find((c) => c.id === 2)!;
    expect(table).toMatchObject({ mode: 'ship', total_usd: 24, extra_usd: 9, road_mi: null, savings_usd: 40, dims_approx: false });
  });

  it('zero-vector embeddings (NaN cosine) fall back to keyword similarity instead of breaking ranking', async () => {
    const emb = Array.from({ length: 768 }, (_, i) => (i % 7) / 7);
    const cards = await run({ categories: ['desk_lamp'], style_text: 'warm wood' }, emb);
    expect(cards.length).toBe(2);
    expect(cards.every((c) => Number.isFinite(c.score))).toBe(true);
  });

  it('real embeddings drive the ranking when present', async () => {
    const v = (hot: number) => `[${Array.from({ length: 768 }, (_, i) => (i === hot ? 1 : 0)).join(',')}]`;
    await query('update listing_details set embedding = $1::vector where listing_id = 4', [v(3)]);
    await query('update listing_details set embedding = $1::vector where listing_id = 1', [v(9)]);
    const q = Array.from({ length: 768 }, (_, i) => (i === 3 ? 1 : 0));
    const cards = await run({ categories: ['desk_lamp'] }, q);
    expect(cards[0].id).toBe(4); // cosine sim 1 beats the free pinned lamp at sim 0
    await query(`update listing_details set embedding = array_fill(0, array[768])::vector where listing_id in (1, 4)`);
  });

  it('distance filter: max_drive_min wins and shipped items always pass', async () => {
    const cards = await run({ max_drive_min: 5 }); // ~2.1 road miles
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(c.mode === 'ship' || (c.road_mi ?? 99) <= 2.1).toBe(true);
    expect(cards.some((c) => c.mode === 'ship')).toBe(true);
  });

  it('pickup only hides shipped-only items; ships_only hides pickups', async () => {
    expect((await run({ ships_ok: false })).every((c) => c.mode === 'pickup')).toBe(true);
    const shipped = await run({ ships_only: true });
    expect(shipped.length).toBe(2);
    expect(shipped.every((c) => c.mode === 'ship')).toBe(true);
  });

  it('no car: only shipped or walkable-and-light items, and never a car-fit badge', async () => {
    const cards = await run({ has_car: false, car_make_model: 'Honda Civic', origin_text: 'La Jolla Village' });
    const here = await searchListingsSql(parseSearchArgs({ has_car: false }), { lat: 32.869, lng: -117.233, label: 'x', source: 'said' }, null, FUEL, { branch: 'main' });
    expect(cards.every((c) => c.mode === 'ship')).toBe(true); // nothing within 1 road mile of UCSD
    const walk = here.find((c) => c.mode === 'walk');
    expect(walk).toMatchObject({ id: 1, total_usd: 0, extra_usd: 0 }); // 4 lb lamp, same block
    for (const c of [...cards, ...here]) {
      expect(c.car_fit).toBeNull();
      expect(c.mode).not.toBe('pickup');
    }
  });

  it('car fit in SQL agrees with the carFit module, and too-big items rank lower but still appear', async () => {
    const cars = await fetchCars('main');
    const civic = cars.find((c) => c.make_model === 'Honda Civic')!;
    const cards = await run({ car_make_model: 'civic', max_distance_mi: 30 });
    expect(cards.length).toBeGreaterThan(4);
    for (const c of cards) {
      expect(c.car_name).toBe('Honda Civic');
      expect(c.car_fit).toBe(carFit({ w: c.w_in!, d: c.d_in!, h: c.h_in! }, civic));
    }
    expect(cards.find((c) => c.id === 8)?.car_fit).toBe('seats_folded'); // 60 in dresser, seats down
    expect(cards.find((c) => c.id === 7)?.car_fit).toBe('too_big'); // 71 in bookshelf
    const without = await run({ max_distance_mi: 30 });
    expect(cards.findIndex((c) => c.id === 7)).toBeGreaterThanOrEqual(without.findIndex((c) => c.id === 7));
  });

  it('an unknown car yields no badge (the UI says "Couldn\'t check your car")', async () => {
    const cards = await run({ car_make_model: 'DeLorean DMC-12' });
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => c.car_fit === null && c.car_name === null)).toBe(true);
  });

  it('dimension, budget and free filters', async () => {
    expect((await run({ max_h_in: 20 })).every((c) => (c.h_in ?? 0) <= 20)).toBe(true);
    expect((await run({ max_total_usd: 20 })).every((c) => c.total_usd <= 20)).toBe(true);
    const free = await run({ free_only: true });
    expect(free.map((c) => c.id)).toEqual([1]);
    expect(await run({ max_total_usd: 0.01, ships_only: true })).toEqual([]);
  });

  it('flags approx dims and approx models', async () => {
    const cards = await run({ max_distance_mi: 30 });
    expect(cards.find((c) => c.id === 5)).toMatchObject({ is_approx_model: true, asset_status: 'fallback_ready' });
    expect(cards.find((c) => c.id === 3)!.dims_approx).toBe(true); // estimated
    expect(cards.find((c) => c.id === 7)!.dims_approx).toBe(false); // from listing text, model matches
  });

  it('inactive listings disappear', async () => {
    await query('update listings set is_active = false where id = 6');
    expect((await run({ ships_only: true })).map((c) => c.id)).toEqual([2]);
    await query('update listings set is_active = true where id = 6');
  });

  it('the TypeScript evaluator (offline snapshot path) matches SQL on ids, totals and modes', async () => {
    const [items, cars] = await Promise.all([fetchRawItems('all-with-models', 'main'), fetchCars('main')]);
    for (const raw of [
      {}, { categories: ['desk_lamp', 'side_table'], max_total_usd: 40, style_text: 'warm wood', car_make_model: 'Honda Civic' },
      { has_car: false }, { ships_only: true }, { max_distance_mi: 30, car_make_model: 'Toyota RAV4' }, { free_only: true },
    ]) {
      const f = parseSearchArgs(raw);
      const a = await searchListingsSql(f, UCSD, null, FUEL, { branch: 'main' });
      const b = evaluate(items, f, UCSD, cars, FUEL);
      const key = (c: (typeof a)[number]) => `${c.id}|${c.mode}|${c.total_usd.toFixed(2)}|${c.car_fit}`;
      expect(b.map(key), JSON.stringify(raw)).toEqual(a.map(key));
    }
  });
});

describe('spoken summary and empty states', () => {
  it('summarises counts, the closest item and savings', async () => {
    const f = keywordParse('desk lamp and side table under $40, warm wood, I drive a Civic');
    const cards = await searchListingsSql(f, UCSD, null, FUEL, { branch: 'main' });
    const s = spokenSummary(cards, f);
    expect(s).toMatch(/^Found 2 desk lamps and 1 side table under \$40\./);
    expect(s).toMatch(/The closest is free, about 1\.\d miles away\./);
    expect(s).toMatch(/saves about \$40 versus new/);
    expect(s).toMatch(/fit in your Civic/);
    expect(s.length).toBeLessThan(400);
  });
  it('empty search: clear message plus one-tap widen chips', () => {
    const f = parseSearchArgs({ categories: ['desk'], max_total_usd: 10, ships_ok: false, style_text: 'pink' });
    expect(emptyMessage(f)).toBe('No matches under $10 within 10 miles.');
    expect(spokenSummary([], f)).toBe('No matches under $10 within 10 miles.');
    const labels = widenChips(f).map((c) => c.label);
    expect(labels).toEqual(['Raise budget to $15', 'Include shipped items', 'Any style', 'Search within 25 miles']);
    expect(emptyMessage(parseSearchArgs({ has_car: false }))).toMatch(/walking distance or shipped/);
  });
});
