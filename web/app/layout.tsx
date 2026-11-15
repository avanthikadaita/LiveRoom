import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { DebugConsole } from '@/components/DebugConsole';
import './globals.css';

export const metadata: Metadata = {
  title: 'FitCheck: see used furniture in your room before you pick it up',
  description:
    'Say what you need. FitCheck finds used furniture near you on Craigslist, Facebook Marketplace and eBay, and shows the real item at true size in AR.',
  metadataBase: process.env.NEXT_PUBLIC_SITE_URL ? new URL(process.env.NEXT_PUBLIC_SITE_URL) : undefined,
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#8d402e' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Instrument+Sans:wght@400..700&display=swap"
        />
      </head>
      <body>
        <header className="bg-paper">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
            <Link href="/" className="font-display text-2xl font-extrabold tracking-tight">
              FitCheck
            </Link>
            <nav aria-label="Main" className="flex gap-0.5 text-sm font-semibold sm:gap-1">
              <Link className="rounded-md px-1.5 py-2 hover:bg-white sm:px-2.5" href="/corner">Corner</Link>
              <Link className="rounded-md px-1.5 py-2 hover:bg-white sm:px-2.5" href="/impact">Impact</Link>
              <Link className="rounded-md px-1.5 py-2 hover:bg-white sm:px-2.5" href="/sell">Sell</Link>
            </nav>
          </div>
          <div className="tape-rule" aria-hidden="true" />
        </header>
        <main className="mx-auto max-w-6xl px-4 pb-24 pt-6">{children}</main>
        <DebugConsole />
      </body>
    </html>
  );
}
