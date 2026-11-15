// The Mastra agent end to end, with Google's HTTP API mocked: tool wiring, per-request key,
// request-context stash, step cap and the fall-through when the model misbehaves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore, configureLimits } from '@/lib/limits';
import { handleSearch } from '@/lib/search/run';

const realFetch = globalThis.fetch;
const DEMO = 'desk lamp and side table under $40, warm wood, I drive a Civic';
let seen: { url: string; key: string | null; body: any }[] = [];

const sse = (obj: object) => new Response(`data: ${JSON.stringify(obj)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const json = (obj: object) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
const usage = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 };

function mockGoogle(handler: (turn: number, body: any) => object | Response) {
  let turn = 0;
  globalThis.fetch = vi.fn(async (input: any, init: any) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? input);
    const headers = new Headers(init?.headers ?? input?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    seen.push({ url, key: headers.get('x-goog-api-key'), body });
    if (url.includes(':embedContent')) return json({ embedding: { values: Array(768).fill(0.01) } });
    const out = handler(turn++, body);
    if (out instanceof Response) return out;
    return url.includes('alt=sse') || url.includes(':streamGenerateContent') ? sse(out) : json(out);
  }) as any;
}

beforeEach(() => {
  seen = [];
  process.env.DATABASE_URL = 'pglite://fixtures';
  process.env.DATABASE_URL_DEMO = 'pglite://fixtures';
  process.env.DEMO_MODE = '1';
  process.env.SEARCH_ENGINE = 'agent';
  process.env.GEMINI_API_KEYS = 'agent-key-1,agent-key-2';
  process.env.AGENT_TIMEOUT_MS = '15000';
  configureLimits({ store: new MemoryStore(), now: () => new Date(), resetBreakers: true, sleep: async () => {} });
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('FitCheckShopper agent', () => {
  it('calls searchListings through Mastra and returns the unchanged output contract', async () => {
    mockGoogle((turn) =>
      turn === 0
        ? { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'searchListings', args: {
            categories: ['desk_lamp', 'side_table'], max_total_usd: 40, style_text: 'warm wood', car_make_model: 'Honda Civic', has_car: true } } }] }, finishReason: 'STOP' }], usageMetadata: usage }
        : { candidates: [{ content: { role: 'model', parts: [{ text: 'Found three that fit your Civic.' }] }, finishReason: 'STOP' }], usageMetadata: usage });
    const out = await handleSearch({ text: DEMO }, { thread: 't1', resource: 'r1' });
    expect(out.engine).toBe('agent');
    expect(out.results.length).toBe(3);
    expect(out.filters).toMatchObject({ categories: ['desk_lamp', 'side_table'], max_total_usd: 40, car_make_model: 'Honda Civic' });
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['filters', 'results', 'spoken_summary', 'profile']));
    expect(out.assistant_text).toBe('Found three that fit your Civic.');
    const gen = seen.filter((s) => s.url.includes('enerateContent'));
    expect(gen.length).toBe(2); // tool step + closing sentence
    expect(gen[0].url).toContain('generativelanguage.googleapis.com');
    expect(gen.every((s) => s.key === 'agent-key-1')).toBe(true); // key comes from lib/limits rotation
    const names = (gen[0].body.tools ?? []).flatMap((t: any) => (t.functionDeclarations ?? []).map((f: any) => f.name));
    expect(names).toEqual(expect.arrayContaining(['resolveOrigin', 'searchListings', 'checkCarFit', 'compareToNew', 'verifyStillListed']));
  });

  it('stops after 4 steps even if the model keeps calling tools', async () => {
    mockGoogle(() => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'searchListings', args: { categories: ['stool'] } } }] }, finishReason: 'STOP' }], usageMetadata: usage }));
    const out = await handleSearch({ text: 'stool' }, { thread: 't2', resource: 'r2' });
    expect(seen.filter((s) => s.url.includes('enerateContent')).length).toBeLessThanOrEqual(4);
    expect(out.engine).toBe('agent');
    expect(out.results.map((r) => r.id)).toEqual([6]);
  });

  it('falls back to the direct Gemini call, then the keyword parser, when the agent never searches', async () => {
    mockGoogle(() => ({ candidates: [{ content: { role: 'model', parts: [{ text: 'I cannot help with that.' }] }, finishReason: 'STOP' }], usageMetadata: usage }));
    const out = await handleSearch({ text: DEMO }, { thread: 't3', resource: 'r3' });
    expect(out.engine).toBe('keyword');
    expect(out.results.length).toBe(3);
  });

  it('a 429 inside the agent cools that key down and search still answers', async () => {
    mockGoogle(() => new Response('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota"}}', { status: 429, headers: { 'content-type': 'application/json' } }));
    const out = await handleSearch({ text: DEMO }, { thread: 't4', resource: 'r4' });
    expect(out.engine).toBe('keyword');
    expect(out.results.length).toBe(3);
    expect(new Set(seen.map((s) => s.key))).toEqual(new Set(['agent-key-1', 'agent-key-2']));
  });
});
