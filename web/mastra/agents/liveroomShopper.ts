import { Agent } from '@mastra/core/agent';
import { env } from '@/lib/env';
import { getMemory } from '../memory';
import { shopperTools } from '../tools';

export const SHOPPER_INSTRUCTIONS = `You are FitCheck's shopping assistant for used furniture around UC San Diego.
Shoppers speak short requests like "desk lamp and side table under $40, warm wood, I drive a Civic".

Every turn:
1. Call searchListings exactly once, in your first step, with everything they asked for. Fill only what they said or what you
   remember about them (place, car or no car, budget, style, max drive time). "under forty bucks" means max_total_usd 40.
   "no car", "I walk", "I bike" means has_car false. A place or ZIP they mention goes in origin_text.
2. Follow-ups change the last search instead of starting over: "cheaper" lowers the budget by about a quarter,
   "what about one that ships" sets ships_only true, "my roommate has a RAV4" changes the car.
3. When they tell you something lasting about themselves, update working memory in the same step as the search.
4. Use checkCarFit, compareToNew or verifyStillListed only when asked about a specific item. verifyStillListed is only for the top result.
5. Reply with one short spoken sentence. Never invent prices, distances or dimensions; every number is an estimate.`;

type G = typeof globalThis & { __lr_shopper?: Agent };
const g = globalThis as G;

/**
 * Built once per process (and kept across Next.js hot reloads). Memory is attached only when a real
 * Postgres URL is configured. Model id and key are resolved per request so lib/limits.ts key rotation applies.
 */
export function getShopperAgent(): Agent {
  if (g.__lr_shopper) return g.__lr_shopper;
  const memory = getMemory();
  g.__lr_shopper = new Agent({
    id: 'FitCheckShopper',
    name: 'FitCheck Shopper',
    description: 'Turns a spoken furniture request into a hybrid Neon search, with car-fit, savings and live-listing checks.',
    instructions: SHOPPER_INSTRUCTIONS,
    model: ({ requestContext }) => {
      const apiKey = (requestContext?.get('geminiKey') as string | undefined) ?? env.GEMINI_API_KEYS[0];
      return { id: `google/${env.GEMINI_MODEL_FAST}`, apiKey } as any;
    },
    tools: shopperTools,
    ...(memory ? { memory: memory as any } : {}),
  });
  return g.__lr_shopper;
}
