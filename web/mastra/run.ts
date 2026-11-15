import { RequestContext } from '@mastra/core/request-context';
import { env } from '@/lib/env';
import { AppError, err } from '@/lib/errors';
import { classifyGeminiError, geminiFamily, makeGeminiHttpError } from '@/lib/gemini';
import { QuotaExceeded, pickKey, reportFailure, reportSuccess } from '@/lib/limits';
import type { PrevContext } from '@/lib/search/keywordParser';
import type { Executed } from '@/lib/search/run';
import type { SearchArgs } from '@/lib/search/schema';
import { getMemory } from './memory';
import type { AgentStash } from './tools';

export const AGENT_MAX_STEPS = 4;

export type AgentRun = { filters: SearchArgs; executed: Executed; text: string | null; steps: number };

/** One agent turn. Throws on any failure so the caller can fall back to the direct path. */
export async function runShopperAgent(a: {
  text: string; coords: { lat: number; lng: number } | null; prev: PrevContext; thread: string; resource: string;
}): Promise<AgentRun> {
  let key;
  try {
    key = await pickKey(geminiFamily(env.GEMINI_MODEL_FAST), env.GEMINI_API_KEYS, { perMinute: env.GEMINI_RPM_PARSE, perDay: env.GEMINI_RPD });
  } catch (e) {
    if (e instanceof QuotaExceeded) throw err.quota('Gemini');
    throw e;
  }
  await import('./index'); // registers the agent with the Mastra instance (Studio, traces)
  const agent = (await import('./agents/FitCheckShopper')).getShopperAgent();
  const stash: AgentStash = { coords: a.coords };
  const rc = new RequestContext();
  rc.set('geminiKey', key.key);
  rc.set('stash', stash);

  const memory = getMemory();
  // Without memory (local fixtures) the previous filters ride along in the prompt instead.
  const prompt = !memory && a.prev?.filters
    ? `Last search filters: ${JSON.stringify(a.prev.filters)}\nShopper: ${a.text}`
    : a.text;

  try {
    // hard cap: memory start-up or a slow model must never hold the shopper past the timeout
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('agent timeout')), env.AGENT_TIMEOUT_MS + 250); });
    const res: any = await Promise.race([deadline, agent.generate(prompt, {
      maxSteps: AGENT_MAX_STEPS,
      requestContext: rc,
      abortSignal: AbortSignal.timeout(env.AGENT_TIMEOUT_MS),
      modelSettings: { temperature: 0, maxRetries: 0 }, // retries and rotation are handled by lib/limits.ts
      ...(memory ? { memory: { thread: a.thread, resource: a.resource } } : {}),
    } as any)]).finally(() => clearTimeout(timer));
    reportSuccess(key.provider);
    if (!stash.filters || !stash.executed) {
      throw err.upstream('agent', 'The assistant did not run a search.', true);
    }
    const text = typeof res?.text === 'string' && res.text.trim() ? res.text.trim().slice(0, 300) : null;
    return { filters: stash.filters, executed: stash.executed, text, steps: res?.steps?.length ?? 0 };
  } catch (e: any) {
    if (e instanceof AppError && e.code !== 'agent_error') throw e; // e.g. db_unreachable from the tool
    const status = Number(e?.statusCode ?? e?.status ?? e?.cause?.statusCode ?? 0);
    if (status) {
      await reportFailure(key.provider, classifyGeminiError(makeGeminiHttpError(status, String(e?.responseBody ?? e?.message ?? ''))), 'agent');
    }
    // a search that already ran is still good even if the model's closing sentence failed
    if (stash.filters && stash.executed) return { filters: stash.filters, executed: stash.executed, text: null, steps: 0 };
    if (e instanceof AppError) throw e;
    throw err.upstream('agent', 'The assistant did not answer in time.', true, { message: String(e?.message ?? e).slice(0, 300) });
  }
}
