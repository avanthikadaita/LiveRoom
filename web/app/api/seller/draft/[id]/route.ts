import { NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/db';
import { err, route } from '@/lib/errors';
import { checkIpLimit } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

async function draftId(ctx: Ctx) {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) throw err.notFound('That draft');
  return id;
}

const SELECT = `
  select sd.id::int as id, sd.status, sd.category, sd.title, sd.height_in::float8 as height_in, sd.ask_usd::float8 as ask_usd,
         sd.fair_price_usd::float8 as fair_price_usd, sd.fair_low_usd::float8 as fair_low_usd,
         sd.fair_high_usd::float8 as fair_high_usd, sd.comps_n, sd.error, sd.photo_url,
         sd.listing_id::int as listing_id, coalesce(l.is_active, false) as published,
         a.status::text as asset_status, a.usdz_url, a.glb_url, coalesce(a.is_approx_model, false) as is_approx_model,
         d.w_in::float8 as w_in, d.d_in::float8 as d_in, d.h_in::float8 as h_in
    from seller_drafts sd
    left join listings l on l.id = sd.listing_id
    left join listing_details d on d.listing_id = sd.listing_id
    left join assets a on a.listing_id = sd.listing_id
   where sd.id = $1`;

/** Draft status for the /sell page to poll: new -> processing -> ready (3D model + fair price) | failed. */
export const GET = route('api.seller.draft.get', async (req: Request, ctx: Ctx) => {
  checkIpLimit(req, 'seller-draft-get', 120);
  const [row] = await query(SELECT, [await draftId(ctx)], { branch: 'main' });
  if (!row) throw err.notFound('That draft');
  return NextResponse.json(row, { headers: { 'cache-control': 'no-store' } });
});

const Publish = z.object({ token: z.string().min(16), ask_usd: z.number().min(0).max(100000) });

/** Publish a ready draft: the listing goes live in search at the seller's asking price. */
export const POST = route('api.seller.draft.publish', async (req: Request, ctx: Ctx) => {
  checkIpLimit(req, 'seller-publish', 10);
  const id = await draftId(ctx);
  const body = Publish.parse(await req.json().catch(() => ({})));
  const [d] = await query<{ status: string; listing_id: number | null; edit_token: string | null }>(
    'select status, listing_id::int as listing_id, edit_token from seller_drafts where id = $1', [id], { branch: 'main' },
  );
  if (!d || !d.edit_token || d.edit_token !== body.token) throw err.notFound('That draft');
  if (d.status !== 'ready' || !d.listing_id) throw err.badRequest('The 3D model is not ready yet.');
  await query(
    `update listings set is_active = true, price_usd = $2, scraped_at = now() where id = $1 and source = 'FitCheck'`,
    [d.listing_id, body.ask_usd], { branch: 'main' },
  );
  await query('update seller_drafts set ask_usd = $2, updated_at = now() where id = $1', [id, body.ask_usd], { branch: 'main' });
  return NextResponse.json({ ok: true, listing_id: d.listing_id, item_url: `/item/${d.listing_id}` });
});
