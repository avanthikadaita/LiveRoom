'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';

type Stats = {
  listings: number; free_items: number; savings_available: number; lbs_listed: number; indexed_this_weekend: number;
  models_ready: number; searches: number; ar_views: number; listing_opens: number; dollars_saved_opened: number; lbs_diverted: number;
};
const n = (v: number | undefined) => (v == null ? null : Math.round(v).toLocaleString('en-US'));

export default function ImpactPage() {
  const [s, setS] = useState<Stats | null>(null);
  const [down, setDown] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch('/api/impact', { cache: 'no-store' });
        if (!res.ok) throw new Error();
        const j = await res.json();
        if (alive) { setS(j); setDown(false); }
      } catch { if (alive) setDown(true); }
    };
    void tick();
    const t = setInterval(tick, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const tiles: [string, string | null, string][] = [
    ['Listings indexed this weekend', n(s?.indexed_this_weekend), 'Scraped from Craigslist, Facebook Marketplace and eBay with Bright Data.'],
    ['Free items right now', n(s?.free_items), 'Listed at $0 by their owners.'],
    ['Savings available vs. buying new', s ? `~$${n(s.savings_available)}` : null, 'Estimate: Amazon median for the category minus the used price, summed over active listings.'],
    ['Times someone placed an item in AR', n(s?.ar_views), 'Counted when “See it in your room” is tapped.'],
    ['Furniture kept in use', s ? `~${n(s.lbs_diverted)} lb` : null, 'Estimate: weight of items whose listing was opened from FitCheck.'],
    ['Items you can place in AR', n(s?.models_ready), '3D models made from listing photos, at real size.'],
  ];

  return (
    <div>
      <h1 className="text-4xl font-extrabold">Impact</h1>
      <p className="mt-2 max-w-[65ch] text-lg text-muted">
        Americans throw away about 12 million tons of furniture a year, and most of it is landfilled (EPA estimate). Every number below is an estimate from
        FitCheck&apos;s own database, and says so.
      </p>
      {down && <p role="alert" className="mt-4 rounded-lg bg-warn-soft px-3 py-2 font-semibold text-warn">Can&apos;t reach the database. Retrying every 10 seconds…</p>}
      <dl className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="impact-tiles">
        {tiles.map(([label, value, note]) => (
          <div key={label} className="panel p-5">
            <dt className="font-semibold">{label}</dt>
            <dd className="mt-1 font-display text-5xl font-extrabold">{value ?? <span className="skeleton inline-block h-10 w-24" />}</dd>
            <dd className="mt-2 text-sm text-muted">{note}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-6 max-w-[70ch] text-sm text-muted">
        How the estimates work: savings compare each listing&apos;s total cost with the median new price for its category; weight comes
        from the vision model&apos;s estimate for each item. {s ? `${n(s.searches)} searches and ${n(s.listing_opens)} listing opens so far.` : ''}
      </p>
      <p className="mt-3 text-sm text-muted">
        Curious how a listing becomes a 3D model? <Link className="underline" href="/pipeline">Watch the pipeline live</Link>.
      </p>
    </div>
  );
}
