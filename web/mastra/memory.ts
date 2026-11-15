// Mastra memory on Neon: PostgresStore in a separate `mastra` schema, with working memory
// holding the shopper profile so follow-ups ("cheaper", "my roommate has a RAV4") need no repeats.
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import { z } from 'zod';
import { env } from '@/lib/env';

export const ShopperProfileSchema = z.object({
  location: z.string().optional().describe('Where the shopper is, e.g. "Pepper Canyon"'),
  has_car: z.boolean().optional(),
  car: z.string().optional().describe('Car make and model, e.g. "Honda Civic"'),
  budget_usd: z.number().optional(),
  style: z.string().optional().describe('Look they like, e.g. "warm wood, mid-century"'),
  max_drive_min: z.number().optional(),
});

type G = typeof globalThis & { __lr_mastra_memory?: Memory | null };
const g = globalThis as G;

/** Kept on globalThis so Next.js hot reloads do not open a new pool each time (Mastra docs warning). */
export function getMemory(): Memory | undefined {
  if (g.__lr_mastra_memory !== undefined) return g.__lr_mastra_memory ?? undefined;
  const url = env.DATABASE_URL;
  if (!env.AGENT_MEMORY || !/^postgres(ql)?:\/\//.test(url)) {
    g.__lr_mastra_memory = null;
    return undefined;
  }
  try {
    const storage = new PostgresStore({ id: 'FitCheck-mastra', connectionString: url, schemaName: 'mastra' });
    g.__lr_mastra_memory = new Memory({
      storage,
      options: {
        lastMessages: 6,
        semanticRecall: false,
        workingMemory: { enabled: true, scope: 'resource', schema: ShopperProfileSchema },
      },
    });
  } catch (e) {
    console.error('[mastra.memory] disabled:', (e as Error).message);
    g.__lr_mastra_memory = null;
  }
  return g.__lr_mastra_memory ?? undefined;
}
