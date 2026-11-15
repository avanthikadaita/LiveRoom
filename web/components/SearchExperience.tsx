'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CATEGORY_LABEL, isCategory } from '@/lib/logic/categories';
import type { SearchArgs } from '@/lib/search/schema';
import type { SearchResponse } from '@/lib/search/types';
import { CardSkeleton, ListingCard } from './ListingCard';

type Phase = 'idle' | 'recording' | 'transcribing' | 'searching';
const EXAMPLES = [
  'desk lamp and side table under $40, warm wood',
  'bookshelf under $50 near Pepper Canyon, no car',
  'accent chair, mid-century, within 15 minutes',
];
const ENGINE_LABEL = { agent: 'Understood by the Mastra agent', gemini: 'Understood by Gemini', keyword: 'Understood by the keyword parser' } as const;
// 0.1 s of silence: playing it inside a tap unlocks audio on iOS so the spoken reply can play later.
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

function sessionId(): string {
  try {
    let s = sessionStorage.getItem('lr_sid');
    if (!s) { s = crypto.randomUUID(); sessionStorage.setItem('lr_sid', s); }
    return s;
  } catch { return 'anon'; }
}

function filterChips(f: SearchArgs): string[] {
  const out: string[] = f.categories.map((c) => (isCategory(c) ? CATEGORY_LABEL[c][0] : c));
  if (f.free_only) out.push('free only');
  if (f.max_total_usd) out.push(`under $${f.max_total_usd}`);
  if (f.style_text) out.push(f.style_text);
  if (!f.has_car) out.push('no car');
  else if (f.car_make_model) out.push(f.car_make_model);
  if (f.max_drive_min) out.push(`within ${f.max_drive_min} min`);
  else if (f.max_distance_mi) out.push(`within ${f.max_distance_mi} mi`);
  if (f.ships_only) out.push('shipped only');
  else if (!f.ships_ok) out.push('pickup only');
  if (f.max_w_in) out.push(`max ${f.max_w_in} in wide`);
  if (f.max_h_in) out.push(`max ${f.max_h_in} in tall`);
  return out;
}

export function SearchExperience({ places }: { places: string[] }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [text, setText] = useState('');
  const [data, setData] = useState<SearchResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dbDown, setDbDown] = useState(false);
  const [broken, setBroken] = useState<Record<number, boolean>>({});
  const [editOrigin, setEditOrigin] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const holdingRef = useRef(false);
  const startedAtRef = useRef(0);
  const coordsRef = useRef<{ lat: number; lng: number } | null>(null);
  const dataRef = useRef<SearchResponse | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqRef = useRef(0);
  dataRef.current = data;

  useEffect(() => () => {
    if (retryRef.current) clearTimeout(retryRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  const unlockAudio = () => {
    if (audioRef.current) return;
    const a = new Audio(SILENCE);
    a.addEventListener('ended', () => setSpeaking(false));
    a.addEventListener('pause', () => setSpeaking(false));
    audioRef.current = a;
    a.play().catch(() => {});
  };

  /** Text-to-speech failure is silent by design: the results are already on screen. */
  const speak = useCallback(async (line: string) => {
    const a = audioRef.current;
    if (!a || !line) return;
    try {
      const res = await fetch('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: line }) });
      if (!res.ok) return;
      const blob = await res.blob();
      if (a.src.startsWith('blob:')) URL.revokeObjectURL(a.src);
      a.src = URL.createObjectURL(blob);
      await a.play();
      setSpeaking(true);
    } catch { /* silent */ }
  }, []);

  const runSearch = useCallback(async (q: string, override?: Partial<SearchArgs>) => {
    const query = q.trim();
    if (!query) { setNotice('Say or type what you need, like "desk lamp under $20".'); inputRef.current?.focus(); return; }
    if (retryRef.current) clearTimeout(retryRef.current);
    const my = ++reqRef.current;
    setPhase('searching');
    setNotice(null);
    const prev = dataRef.current;
    const body = {
      text: query, coords: coordsRef.current, session_id: sessionId(), override,
      prev: prev ? { filters: prev.filters, max_seen_total: prev.results.length ? Math.max(...prev.results.map((r) => r.total_usd)) : null } : undefined,
    };
    try {
      const res = await fetch('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => null);
      if (my !== reqRef.current) return;
      if (!res.ok) {
        if (json?.error?.code === 'db_unreachable') {
          setDbDown(true);
          retryRef.current = setTimeout(() => runSearch(query, override), 3000);
          return;
        }
        setDbDown(false);
        setNotice(json?.error?.message ?? 'Search did not go through. Try again.');
        setPhase('idle');
        return;
      }
      const out = json as SearchResponse;
      setDbDown(false);
      setData(out);
      setPhase('idle');
      setEditOrigin(false);
      void speak(out.spoken_summary);
      const ids = out.results.filter((r) => r.has_model).map((r) => r.id);
      if (ids.length && out.data_source === 'live') {
        fetch('/api/models/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => { if (j?.ok) setBroken(Object.fromEntries(Object.entries(j.ok).map(([k, v]) => [k, !v]))); })
          .catch(() => {});
      }
    } catch {
      if (my !== reqRef.current) return;
      setDbDown(true); // offline or server unreachable: same recovery as a database outage
      retryRef.current = setTimeout(() => runSearch(query, override), 3000);
    }
  }, [speak]);

  const micOff = (msg = 'Microphone is off. Type what you need instead.') => {
    setPhase('idle');
    setNotice(msg);
    inputRef.current?.focus();
  };

  const transcribe = async (blob: Blob) => {
    setPhase('transcribing');
    try {
      const form = new FormData();
      form.append('audio', blob, blob.type.includes('mp4') ? 'speech.mp4' : 'speech.webm');
      const res = await fetch('/api/stt', { method: 'POST', body: form });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.text) throw new Error(json?.error?.message ?? 'stt failed');
      setText(json.text);
      await runSearch(json.text);
    } catch {
      setPhase('idle');
      setNotice("Didn't catch that. Try again or type it.");
      inputRef.current?.focus();
    }
  };

  const startRec = async () => {
    if (phase !== 'idle' || holdingRef.current) return;
    holdingRef.current = true;
    unlockAudio();
    audioRef.current?.pause();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      holdingRef.current = false;
      return micOff();
    }
    let stream: MediaStream;
    try {
      stream = streamRef.current?.active ? streamRef.current : await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      holdingRef.current = false;
      return micOff();
    }
    streamRef.current = stream;
    if (!holdingRef.current) { setNotice('Mic is ready. Hold the button while you talk.'); return; } // released during the permission prompt
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const ms = Date.now() - startedAtRef.current;
      const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/mp4' });
      if (ms < 500 || blob.size < 800) { setPhase('idle'); setNotice('Hold the button while you talk, then let go.'); return; }
      void transcribe(blob);
    };
    rec.onerror = () => micOff("Recording stopped unexpectedly. Type what you need instead.");
    recRef.current = rec;
    startedAtRef.current = Date.now();
    setNotice(null);
    setPhase('recording');
    rec.start();
    setTimeout(() => { if (recRef.current === rec && rec.state === 'recording') stopRec(); }, 20_000);
  };

  const stopRec = () => {
    holdingRef.current = false;
    const rec = recRef.current;
    if (rec && rec.state === 'recording') rec.stop();
    recRef.current = null;
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) return setNotice('This browser cannot share a location. Pick a neighborhood instead.');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        // rounded to 2 decimals (about half a mile) before it leaves the phone; never stored
        coordsRef.current = { lat: Math.round(p.coords.latitude * 100) / 100, lng: Math.round(p.coords.longitude * 100) / 100 };
        if (dataRef.current) void runSearch(dataRef.current.query, { origin_text: null });
      },
      () => setNotice('Location is off. Pick a neighborhood instead.'),
      { maximumAge: 300_000, timeout: 8000 },
    );
  };

  const busy = phase === 'transcribing' || phase === 'searching';
  const chips = data ? filterChips(data.filters) : [];

  return (
    <div>
      <section className={`grid items-center gap-6 ${data ? '' : 'pt-4 md:grid-cols-[1.2fr_1fr] md:pt-10'}`}>
        {!data && (
          <div>
            <h1 className="text-[clamp(2.4rem,7vw,4.4rem)] font-extrabold">Used furniture, at true size, in your room.</h1>
            <p className="mt-4 max-w-[52ch] text-lg text-muted">
              Say what you need. LiveRoom searches Craigslist, Facebook Marketplace and eBay near you, then turns the
              listing photo into a 3D model you can place with your phone before you drive anywhere.
            </p>
          </div>
        )}

        <div className={`panel p-4 ${data ? '' : 'md:p-6'}`}>
          <div className={`flex items-center gap-4 ${data ? '' : 'flex-col text-center'}`}>
            <button
              type="button" data-testid="mic"
              aria-label={phase === 'recording' ? 'Recording. Release to search.' : 'Hold to talk'}
              aria-pressed={phase === 'recording'} disabled={busy}
              onPointerDown={(e) => { e.preventDefault(); void startRec(); }}
              onPointerUp={stopRec} onPointerCancel={stopRec} onPointerLeave={() => holdingRef.current && stopRec()}
              onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); void startRec(); } }}
              onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') stopRec(); }}
              onContextMenu={(e) => e.preventDefault()}
              className={`grid shrink-0 select-none place-items-center rounded-full border-[1.5px] border-ink bg-[#8d402e] text-white font-display font-bold
                ${data ? 'h-16 w-16' : 'h-32 w-32'} ${phase === 'recording' ? 'mic-ring scale-105' : ''} disabled:opacity-60`}
              style={{ touchAction: 'none', WebkitTouchCallout: 'none' }}
            >
              <svg viewBox="0 0 24 24" className={data ? 'h-7 w-7' : 'h-12 w-12'} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
              </svg>
            </button>
            <p className="font-semibold" aria-live="polite" data-testid="status">
              {phase === 'recording' ? 'Listening. Let go when you are done.'
                : phase === 'transcribing' ? 'Writing down what you said…'
                : phase === 'searching' ? 'Searching listings…'
                : data ? 'Hold to ask a follow-up' : 'Hold to talk'}
            </p>
          </div>

          <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); unlockAudio(); void runSearch(text); }}>
            <label className="sr-only" htmlFor="q">What do you need?</label>
            <input
              id="q" ref={inputRef} data-testid="query" value={text} onChange={(e) => setText(e.target.value)}
              maxLength={400} enterKeyHint="search" autoComplete="off"
              placeholder={data ? 'Try "cheaper" or "what about one that ships"' : 'desk lamp under $20, warm wood'}
              className="min-h-11 min-w-0 flex-1 rounded-[10px] border-[1.5px] border-ink bg-white px-3 text-base"
            />
            <button className="btn btn-primary" data-testid="search" disabled={busy}>Search</button>
          </form>

          {notice && <p role="status" data-testid="notice" className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-sm font-semibold text-warn">{notice}</p>}

          {!data && (
            <div className="mt-4">
              <p className="text-sm text-muted">Or try one of these:</p>
              <div className="mt-2 flex flex-col gap-2">
                {EXAMPLES.map((ex) => (
                  <button key={ex} type="button" className="rounded-lg border border-line bg-paper px-3 py-2 text-left text-sm hover:border-ink"
                    onClick={() => { unlockAudio(); setText(ex); void runSearch(ex); }}>
                    “{ex}”
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {dbDown && (
        <div role="alert" data-testid="db-down" className="panel mt-6 p-6 text-center">
          <h2 className="text-2xl font-bold">Can&apos;t reach listings right now. Retrying…</h2>
          <p className="mt-2 text-muted">This page tries again every 3 seconds. Nothing you typed is lost.</p>
        </div>
      )}

      {phase === 'searching' && !dbDown && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Searching">
          {Array.from({ length: 3 }, (_, i) => <CardSkeleton key={i} />)}
        </div>
      )}

      {data && phase !== 'searching' && !dbDown && (
        <section className="mt-6" aria-label="Results">
          {data.data_source === 'snapshot' && (
            <p role="status" data-testid="snapshot-banner" className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-sm font-semibold text-warn">
              Showing a saved copy of the demo items while the database reconnects.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="font-semibold" data-testid="origin">
              From {data.origin.label}{data.origin.source === 'default' ? ' (default)' : ''}
              <button className="ml-2 text-blanket underline" onClick={() => setEditOrigin((v) => !v)}>change</button>
            </p>
            {chips.map((c) => <span key={c} className="badge" data-testid="filter-chip">{c}</span>)}
          </div>

          {editOrigin && (
            <div className="panel mt-3 flex flex-wrap items-center gap-2 p-3">
              <label htmlFor="origin" className="text-sm font-semibold">Search from</label>
              <select id="origin" defaultValue="" className="min-h-11 rounded-[10px] border-[1.5px] border-ink bg-white px-2"
                onChange={(e) => { if (e.target.value) { coordsRef.current = null; void runSearch(data.query, { origin_text: e.target.value }); } }}>
                <option value="" disabled>Pick a neighborhood</option>
                {places.map((p) => <option key={p}>{p}</option>)}
              </select>
              <button className="btn btn-quiet" onClick={useMyLocation}>Use my location</button>
              <span className="text-sm text-muted">Location is rounded to about half a mile and never stored.</span>
            </div>
          )}

          <div className="mt-4 flex items-start gap-3">
            <p className="max-w-[70ch] text-lg" data-testid="summary">{data.spoken_summary}</p>
            {data.results.length > 0 && (
              <button className="btn btn-quiet !min-h-9 shrink-0 !px-3 text-sm" onClick={() => { unlockAudio(); if (speaking) audioRef.current?.pause(); else void speak(data.spoken_summary); }}>
                {speaking ? 'Stop' : 'Hear it'}
              </button>
            )}
          </div>
          <p className="mt-1 text-sm text-muted">
            {ENGINE_LABEL[data.engine]} in {(data.latency_ms / 1000).toFixed(1)} s. Distances, gas and savings are estimates.
          </p>

          {data.results.length === 0 ? (
            <div className="panel mt-5 p-6" data-testid="empty">
              <h2 className="text-2xl font-bold">{data.empty_message}</h2>
              <p className="mt-2 text-muted">Widen the search with one tap:</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {data.widen.map((w) => (
                  <button key={w.label} className="btn btn-quiet" data-testid="widen" onClick={() => void runSearch(data.query, w.override)}>{w.label}</button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {data.results.map((c) => (
                <ListingCard key={c.id} card={c} carAsked={data.filters.car_make_model} carUnknown={data.car_unknown} modelBroken={broken[c.id]} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
