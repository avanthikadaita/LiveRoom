'use client';
import Link from 'next/link';
import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { CATEGORIES, CATEGORY_LABEL, type Category } from '@/lib/logic/categories';

type Price = { comparables: number; suggested_usd: number | null; low_usd: number | null; high_usd: number | null; new_median_usd: number | null };
type Draft = {
  id: number; status: 'new' | 'processing' | 'ready' | 'failed'; category: string | null; title: string | null;
  height_in: number; ask_usd: number | null; fair_price_usd: number | null; fair_low_usd: number | null; fair_high_usd: number | null;
  comps_n: number | null; error: string | null; listing_id: number | null; published: boolean;
  asset_status: string | null; usdz_url: string | null; glb_url: string | null; is_approx_model: boolean;
  w_in: number | null; d_in: number | null; h_in: number | null;
};

const STORE = 'FitCheck.sell.draft';
const STEP: Record<string, string> = {
  new: 'Photo received. Waiting for the 3D worker…',
  queued: 'Reading your photo and finding similar listings…',
  cutout: 'Cutting the item out of the background…',
  gen_pending: 'Building the 3D model (about a minute)…',
  gen_done: 'Scaling it to your measurements…',
  exporting: 'Making the AR file for iPhone and Android…',
};

/** Shrink to <= 1600 px JPEG in the browser so uploads stay small and fast on phone data. */
async function shrinkPhoto(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.85));
  } catch {
    return file;
  }
}

/**
 * Seller flow: one photo + the height -> a true-scale 3D listing (same worker pipeline as the buyer side),
 * a fair-price suggestion from comparable listings in Neon, and a link anyone can open in AR.
 */
export default function SellPage() {
  const [file, setFile] = useState<File | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<Category>('side_table');
  const [condition, setCondition] = useState<'like_new' | 'good' | 'fair'>('good');
  const [height, setHeight] = useState('');
  const [ask, setAsk] = useState('');
  const [price, setPrice] = useState<Price | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [auth, setAuth] = useState<{ id: number; token: string } | null>(null);
  const [mvReady, setMvReady] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async (id: number) => {
    try {
      const r = await fetch(`/api/seller/draft/${id}`, { cache: 'no-store' });
      if (r.ok) {
        const d: Draft = await r.json();
        setDraft(d);
        if (d.status === 'ready' || d.status === 'failed') return;
      }
    } catch { /* keep polling */ }
    timer.current = setTimeout(() => void poll(id), 4000);
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) ?? 'null');
      if (saved?.id && saved?.token) { setAuth(saved); void poll(saved.id); }
    } catch { /* ignore */ }
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [poll]);

  useEffect(() => {
    if (draft?.status === 'ready' && draft.glb_url) import('@google/model-viewer').then(() => setMvReady(true)).catch(() => {});
  }, [draft?.status, draft?.glb_url]);

  const suggest = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/seller/price', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category, condition }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error?.message ?? 'Could not get a price.');
      setPrice(j);
    } catch (e) { setPrice(null); setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const create = async () => {
    setMsg(null);
    if (!file) return setMsg('Add a photo of the item first.');
    const h = Number(height);
    if (!Number.isFinite(h) || h <= 0 || h >= 120) return setMsg('Enter how tall it is, in inches.');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set('photo', await shrinkPhoto(file), 'photo.jpg');
      fd.set('height_in', String(h));
      fd.set('title', title || CATEGORY_LABEL[category][0]);
      fd.set('category', category);
      if (ask) fd.set('ask_usd', ask);
      const res = await fetch('/api/seller/draft', { method: 'POST', body: fd });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error?.message ?? 'Could not start your listing.');
      const a = { id: j.id as number, token: j.token as string };
      setAuth(a);
      localStorage.setItem(STORE, JSON.stringify(a));
      setDraft(null);
      void poll(a.id);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const publish = async () => {
    if (!auth || !draft) return;
    const v = Number(ask || draft.ask_usd || draft.fair_price_usd || 0);
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`/api/seller/draft/${auth.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: auth.token, ask_usd: v }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error?.message ?? 'Could not publish.');
      setDraft({ ...draft, published: true, ask_usd: v });
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const startOver = () => {
    localStorage.removeItem(STORE);
    if (timer.current) clearTimeout(timer.current);
    setAuth(null); setDraft(null); setFile(null); setPhoto(null); setMvReady(false);
  };

  const inputCls = 'mt-1 block min-h-11 w-full rounded-[10px] border-[1.5px] border-ink px-3';
  const dims = draft?.w_in && draft?.d_in && draft?.h_in ? `${Math.round(draft.w_in)}" W × ${Math.round(draft.d_in)}" D × ${Math.round(draft.h_in)}" H` : null;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-4xl font-extrabold">Sell it, Don't Dumping it</h1>
      <p className="mt-2 text-lg text-muted">
        One clean photo and its height. We turn it into a true-size 3D model buyers can place in their room, and suggest a fair price from similar listings nearby.
      </p>

      {!auth && (
        <form className="panel mt-5 space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <label className="block font-semibold">Photo of the item
            <input type="file" accept="image/*" capture="environment" className="mt-1 block w-full text-sm"
              onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); setPhoto(f ? URL.createObjectURL(f) : null); }} />
            <span className="mt-1 block text-sm font-normal text-muted">For an accurate 3D model: the whole item in frame, nothing on top of it, plain wall or floor behind.</span>
          </label>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {photo && <img src={photo} alt="Your item" className="max-h-64 rounded-xl border border-line object-contain" />}
          <label className="block font-semibold">Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Solid oak side table" maxLength={120} className={inputCls} />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block font-semibold">What is it?
              <select value={category} onChange={(e) => setCategory(e.target.value as Category)} className="mt-1 block min-h-11 w-full rounded-[10px] border-[1.5px] border-ink bg-white px-2">
                {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c][0]}</option>)}
              </select>
            </label>
            <label className="block font-semibold">Condition
              <select value={condition} onChange={(e) => setCondition(e.target.value as typeof condition)} className="mt-1 block min-h-11 w-full rounded-[10px] border-[1.5px] border-ink bg-white px-2">
                <option value="like_new">Like new</option><option value="good">Good</option><option value="fair">Fair</option>
              </select>
            </label>
            <label className="block font-semibold">Height (inches)
              <input inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} placeholder="22" className={inputCls} />
            </label>
            <label className="block font-semibold">Asking price ($, optional)
              <input inputMode="decimal" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="40" className={inputCls} />
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <button className="btn btn-primary" disabled={busy}>{busy ? 'Uploading…' : 'Make my 3D listing'}</button>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void suggest()}>Just suggest a price</button>
          </div>
        </form>
      )}

      {msg && <p role="alert" className="mt-3 rounded-lg bg-warn-soft px-3 py-2 font-semibold text-warn">{msg}</p>}

      {!auth && price && (
        <section className="panel mt-4 p-5" aria-live="polite">
          {price.suggested_usd == null ? (
            <p className="font-semibold">No comparable {CATEGORY_LABEL[category][1]} are listed yet, so there is no price to suggest.</p>
          ) : (
            <>
              <p className="text-muted">Price that should sell this week (estimate)</p>
              <p className="font-display text-6xl font-extrabold">${price.suggested_usd}</p>
              <p className="mt-1 text-muted">
                Quick sale ~${price.low_usd}, typical ${price.high_usd}, from {price.comparables} similar local listing{price.comparables === 1 ? '' : 's'} on Craigslist and Marketplace.
              </p>
            </>
          )}
        </section>
      )}

      {auth && (
        <section className="panel mt-5 p-5" aria-live="polite">
          {(!draft || draft.status === 'new' || draft.status === 'processing') && (
            <>
              <p className="text-lg font-bold">Making your 3D listing</p>
              <p className="mt-1 text-muted">{STEP[draft?.status === 'processing' ? draft.asset_status ?? 'queued' : 'new'] ?? 'Working on it…'}</p>
              <div className="skeleton mt-4 h-3 w-full rounded-full" />
              {draft?.fair_price_usd != null && (
                <p className="mt-4">Price that should sell (estimate): <b>${Math.round(draft.fair_price_usd)}</b> <span className="text-muted">(quick sale ~${Math.round(draft.fair_low_usd ?? 0)}, typical ${Math.round(draft.fair_high_usd ?? 0)}, from {draft.comps_n} similar local listings)</span></p>
              )}
              <p className="mt-3 text-sm text-muted">Usually 1 to 3 minutes. You can leave this page open; it updates by itself.</p>
            </>
          )}

          {draft?.status === 'failed' && (
            <>
              <p className="text-lg font-bold">We couldn&apos;t make a 3D model from that photo</p>
              <p className="mt-1 text-muted">Try a photo with the whole item in frame, from a slight angle, on a plain background.</p>
              <button className="btn btn-primary mt-4" onClick={startOver}>Try another photo</button>
            </>
          )}

          {draft?.status === 'ready' && (
            <>
              <p className="text-lg font-bold">Your item in 3D{draft.is_approx_model ? ' (approximate shape)' : ''}</p>
              <div className="mt-3 aspect-square w-full overflow-hidden rounded-xl bg-paper">
                {mvReady && draft.glb_url ? createElement('model-viewer', {
                  src: draft.glb_url, 'ios-src': draft.usdz_url ?? undefined, alt: `3D model of ${draft.title ?? 'your item'}`,
                  ar: true, 'ar-modes': 'scene-viewer webxr quick-look', 'ar-scale': 'fixed', 'camera-controls': true,
                  'auto-rotate': true, 'shadow-intensity': '0.8', 'touch-action': 'pan-y', style: { width: '100%', height: '100%' },
                }) : <div className="skeleton h-full w-full" />}
              </div>
              {dims && <p className="mt-2 text-sm text-muted">True size: {dims}. On a phone, tap the AR button to place it in a room.</p>}
              {draft.fair_price_usd != null ? (
                <p className="mt-4">Price that should sell (estimate): <b className="text-2xl">${Math.round(draft.fair_price_usd)}</b>{' '}
                  <span className="text-muted">(quick sale ~${Math.round(draft.fair_low_usd ?? 0)}, typical ${Math.round(draft.fair_high_usd ?? 0)}, from {draft.comps_n} similar local listings)</span></p>
              ) : (
                <p className="mt-4 text-muted">Not enough similar listings yet to suggest a price.</p>
              )}
              {draft.published ? (
                <p className="mt-4 rounded-lg bg-paper px-3 py-2 font-semibold">
                  Live at ${draft.ask_usd}. <Link className="underline" href={`/item/${draft.listing_id}`}>Open your listing</Link> to share its QR code.
                </p>
              ) : (
                <div className="mt-4 flex flex-wrap items-end gap-3">
                  <label className="block font-semibold">Your price ($)
                    <input inputMode="decimal" value={ask || String(draft.ask_usd ?? (draft.fair_price_usd != null ? Math.round(draft.fair_price_usd) : ''))}
                      onChange={(e) => setAsk(e.target.value)} className="mt-1 block min-h-11 w-32 rounded-[10px] border-[1.5px] border-ink px-3" />
                  </label>
                  <button className="btn btn-primary" disabled={busy} onClick={() => void publish()}>{busy ? 'Publishing…' : 'Publish listing'}</button>
                </div>
              )}
              <button className="btn btn-quiet mt-4" onClick={startOver}>Sell something else</button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
