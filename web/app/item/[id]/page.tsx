import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import QRCode from 'qrcode';
import { ListingCard } from '@/components/ListingCard';
import { env } from '@/lib/env';
import { AppError } from '@/lib/errors';
import { getItemCard } from '@/lib/search/item';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

async function load(idRaw: string) {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return getItemCard(id);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  try {
    const it = await load((await params).id);
    return it ? { title: `${it.card.title} | FitCheck` } : { title: 'Item not found | FitCheck' };
  } catch {
    return { title: 'FitCheck' };
  }
}

/** The QR target: one item, large, with its own QR code so the next person can scan it too. */
export default async function ItemPage({ params }: Props) {
  const { id } = await params;
  let it: Awaited<ReturnType<typeof load>>;
  try {
    it = await load(id);
  } catch (e) {
    if (e instanceof AppError && e.code === 'db_unreachable') {
      return (
        <div className="panel mx-auto mt-8 max-w-md p-6 text-center" role="alert">
          <h1 className="text-2xl font-bold">Can&apos;t reach listings right now</h1>
          <p className="mt-2 text-muted">Give it a few seconds, then reload this page.</p>
          <a className="btn btn-primary mt-5" href={`/item/${id}`}>Reload</a>
        </div>
      );
    }
    throw e;
  }
  if (!it) notFound();
  const h = await headers();
  const base = env.SITE_URL || `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('x-forwarded-host') ?? h.get('host')}`;
  const url = `${base}/item/${it.card.id}`;
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#15233b', light: '#ffffff' } }).catch(() => '');

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/" className="text-sm font-semibold text-blanket underline">Search more listings</Link>
      {it.data_source === 'snapshot' && (
        <p role="status" className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-sm font-semibold text-warn">
          Showing a saved copy while the database reconnects.
        </p>
      )}
      <div className="mt-3">
        <ListingCard card={it.card} large />
      </div>
      <section className="panel mt-4 flex flex-col items-center gap-4 p-5 sm:flex-row">
        {qrSvg ? (
          <div data-testid="item-qr" role="img" aria-label={`QR code linking to ${url}`} className="h-44 w-44 shrink-0" dangerouslySetInnerHTML={{ __html: qrSvg }} />
        ) : null}
        <div>
          <h2 className="text-xl font-bold">Scan to see it on your own phone</h2>
          <p className="mt-1 text-muted">
            On an iPhone or iPad, tap &ldquo;See it in your room&rdquo; to place it at true size. Distance here is measured from UCSD.
          </p>
          <p className="mt-2 break-all text-sm font-semibold">{url}</p>
        </div>
      </section>
    </div>
  );
}
