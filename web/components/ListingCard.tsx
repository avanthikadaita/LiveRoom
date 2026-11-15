'use client';
import { useEffect, useRef, useState } from 'react';
import { AR_BANNER_TAPPED } from '@/lib/logic/arHref';
import { shortCarName } from '@/lib/logic/carFit';
import { formatDistance, formatUsdShort } from '@/lib/logic/cost';
import type { Card } from '@/lib/search/types';
import { ModelPreview } from './ModelPreview';
import { QrDialog } from './QrDialog';

const SOURCE: Record<Card['source'], string> = { craigslist: 'Craigslist', fb_marketplace: 'Facebook Marketplace', ebay: 'eBay', liveroom: 'LiveRoom seller' };
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const smallMoney = (n: number) => (n < 1 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);

export function dimsText(c: Pick<Card, 'w_in' | 'd_in' | 'h_in'>): string | null {
  return c.w_in && c.d_in && c.h_in ? `${num(c.w_in)} × ${num(c.d_in)} × ${num(c.h_in)} in` : null;
}

export function recordImpact(listing_id: number, kind: 'ar_view' | 'listing_open') {
  try {
    fetch('/api/impact', {
      method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listing_id, kind }),
    }).catch(() => {});
  } catch { /* analytics never blocks the shopper */ }
}

/** True on iOS/iPadOS Safari, where <a rel="ar"> opens AR Quick Look. */
function useArQuickLook() {
  const [ok, setOk] = useState(false);
  useEffect(() => { setOk(!!document.createElement('a').relList?.supports?.('ar')); }, []);
  return ok;
}

export function ListingCard({ card: c, carAsked, carUnknown, modelBroken, large }: {
  card: Card; carAsked?: string | null; carUnknown?: boolean; modelBroken?: boolean; large?: boolean;
}) {
  const arRef = useRef<HTMLAnchorElement>(null);
  const quickLook = useArQuickLook();
  const [preview, setPreview] = useState(false);
  const [qr, setQr] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);

  const hasAr = c.has_model && !!c.ar_href && !modelBroken;
  const dims = dimsText(c);
  const car = c.car_name ? shortCarName(c.car_name) : null;

  // AR Quick Look banner: "View listing" tapped inside AR
  useEffect(() => {
    const a = arRef.current;
    if (!a) return;
    const onMessage = (e: Event) => {
      if ((e as MessageEvent).data === AR_BANNER_TAPPED) {
        recordImpact(c.id, 'listing_open');
        window.location.href = c.url;
      }
    };
    a.addEventListener('message', onMessage);
    return () => a.removeEventListener('message', onMessage);
  }, [c.id, c.url, hasAr]);

  const openAr = () => {
    recordImpact(c.id, 'ar_view');
    if (quickLook && arRef.current) arRef.current.click();
    else setPreview(true);
  };

  const photo = !photoFailed && c.photo ? c.photo : '/fixtures/placeholder.svg';
  // eslint-disable-next-line @next/next/no-img-element
  const img = <img src={photo} alt={c.title} loading="lazy" onError={() => setPhotoFailed(true)} className="h-full w-full object-cover" />;

  return (
    <article data-testid="card" data-id={c.id} className={`panel flex flex-col overflow-hidden ${large ? 'md:flex-row' : ''}`}>
      <div className={`relative bg-[#eef1f5] ${large ? 'md:w-1/2' : ''}`}>
        <div className="aspect-square w-full">
          {hasAr ? (
            // The anchor's only child is the <img>, as AR Quick Look requires.
            <a ref={arRef} rel="ar" href={c.ar_href!} data-testid="ar-link" className="block h-full w-full"
              onClick={(e) => { if (!quickLook) { e.preventDefault(); recordImpact(c.id, 'ar_view'); setPreview(true); } else if (e.isTrusted) recordImpact(c.id, 'ar_view'); }}>
              {img}
            </a>
          ) : img}
        </div>
        <div className="sticker absolute left-3 top-3" aria-hidden="true">{formatUsdShort(c.price_usd)}</div>
        {dims && (
          <>
            <div className="dim-w" aria-hidden="true"><span>{num(c.w_in!)} in</span></div>
            <div className="dim-h" aria-hidden="true"><span>{num(c.h_in!)} in</span></div>
          </>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <h3 className={`${large ? 'text-3xl' : 'text-xl'} font-bold`}>{c.title}</h3>

        <p className="text-[1.05rem] font-semibold">
          {c.total_usd <= 0 ? 'FREE' : c.mode === 'ship' ? `Ships ${formatUsdShort(c.extra_usd).replace('FREE', 'free')}, total ${smallMoney(c.total_usd)}` : `${formatUsdShort(c.price_usd)}`}
          {c.mode === 'pickup' && c.road_mi != null && c.loc_precise === false && (
            <span className="font-normal text-muted"> · pickup in San Diego, exact area not listed (~{smallMoney(c.extra_usd)} gas est.)</span>
          )}
          {c.mode === 'pickup' && c.road_mi != null && c.loc_precise !== false && (
            <span className="font-normal text-muted"> · {formatDistance(c.road_mi)} pickup (~{smallMoney(c.extra_usd)} gas est., ~{c.drive_min} min drive)</span>
          )}
          {c.mode === 'walk' && c.road_mi != null && (
            <span className="font-normal text-muted"> · {formatDistance(c.road_mi)}, walkable pickup</span>
          )}
          {c.mode === 'ship' && <span className="font-normal text-muted"> · arrives by mail</span>}
        </p>

        <div className="flex flex-wrap items-center gap-1.5">
          {dims && <span className="badge">{dims}</span>}
          {dims && c.dims_approx && <span className="badge badge-approx">approx</span>}
          {c.savings_usd != null && c.savings_usd > 0 && <span className="badge badge-go">Saves ~${c.savings_usd} vs. new (est.)</span>}
          {c.car_fit === 'fits' && <span className="badge badge-go" data-testid="car-fit">✅ Fits your {car} (est.)</span>}
          {c.car_fit === 'seats_folded' && <span className="badge badge-warn" data-testid="car-fit">⚠️ {car}: seats folded (est.)</span>}
          {c.car_fit === 'too_big' && (
            <span className="badge badge-stop" data-testid="car-fit">
              ❌ Too big for your {car}{c.ships && c.shipping_usd != null && c.mode !== 'ship' ? `, ships for ${formatUsdShort(c.shipping_usd)}` : ''}
            </span>
          )}
          {carAsked && carUnknown && <span className="badge badge-approx">Couldn&apos;t check your car</span>}
          {!c.is_active && <span className="badge badge-warn">May be sold, last seen {c.found_ago}</span>}
        </div>

        <p className="text-sm text-muted">{SOURCE[c.source]}{c.city ? `, ${c.city}` : ''}. Found {c.found_ago}.</p>

        <div className="mt-auto flex flex-col gap-2 pt-2">
          {hasAr ? (
            <button className="btn btn-tape" data-testid="ar-button" onClick={openAr}>See it in your room</button>
          ) : c.has_model && c.glb_url ? (
            <button className="btn btn-tape" onClick={() => setPreview(true)}>Open 3D preview</button>
          ) : (
            <p className="badge justify-center !py-3 text-sm" data-testid="model-coming">No 3D model of this one yet</p>
          )}
          <div className="flex flex-wrap gap-2">
            {hasAr && c.glb_url && <button className="btn btn-quiet flex-1 whitespace-nowrap !px-2 text-sm" onClick={() => setPreview(true)}>3D preview</button>}
            <a className="btn btn-quiet flex-1 whitespace-nowrap !px-2 text-sm" href={c.url} target="_blank" rel="noopener noreferrer"
              onClick={() => recordImpact(c.id, 'listing_open')}>View listing</a>
            <button className="btn btn-quiet flex-1 whitespace-nowrap !px-2 text-sm" onClick={() => setQr(true)} aria-label={`Show QR code for ${c.title}`}>QR</button>
          </div>
        </div>
      </div>

      {preview && <ModelPreview glb={c.glb_url} usdz={c.usdz_url} title={c.title} dims={dims} onClose={() => setPreview(false)} />}
      {qr && <QrDialog id={c.id} title={c.title} onClose={() => setQr(false)} />}
    </article>
  );
}

export function CardSkeleton() {
  return (
    <div className="panel overflow-hidden" aria-hidden="true">
      <div className="skeleton aspect-square w-full !rounded-none" />
      <div className="space-y-2 p-4">
        <div className="skeleton h-6 w-4/5" />
        <div className="skeleton h-5 w-3/5" />
        <div className="skeleton h-5 w-2/5" />
        <div className="skeleton mt-3 h-11 w-full" />
      </div>
    </div>
  );
}
