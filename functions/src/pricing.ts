// Published upstream token prices.
//
// Every rate is USD per 1,000,000 tokens, matching how OpenAI and Anthropic
// publish them. The unit matters: an earlier table stored per-1M figures but
// divided token counts by 1,000, which overstated every cost by 1000x and
// therefore drained API-key quotas 1000x too fast.
//
// Standard (non-batch, non-fast) tier, short-context column where a provider
// splits by context length. Verified against:
//   https://developers.openai.com/api/docs/pricing
//   https://platform.claude.com/docs/en/docs/about-claude/pricing
//
// Only the model families this gateway actually serves are listed. An unlisted
// model still bills, using DEFAULT_RATE, and the usage row is flagged
// cost_estimated so the dashboard can say the number is a guess rather than a
// published price.

export interface TokenRate {
  /** USD per 1M input tokens. */
  prompt: number;
  /** USD per 1M output tokens. */
  completion: number;
}

const TOKENS_PER_UNIT = 1_000_000;

/**
 * Longest-prefix match, so a dated or suffixed id resolves to its family:
 * `gpt-5.6-sol-2026-03-09` and `claude-opus-5-20260214` both find their base
 * rate instead of silently falling through to the estimate.
 */
const OPENAI_RATES: Array<[string, TokenRate]> = [
  ['gpt-5.6-cyber', { prompt: 12.5, completion: 75 }],
  ['gpt-5.6-sol', { prompt: 4, completion: 20 }],
  ['gpt-5.6-terra', { prompt: 2, completion: 12 }],
  ['gpt-5.6-luna', { prompt: 0.2, completion: 1.2 }],
  ['gpt-5.5-cyber', { prompt: 12.5, completion: 75 }],
  ['gpt-5.5-pro', { prompt: 30, completion: 180 }],
  ['gpt-5.5', { prompt: 5, completion: 30 }]
];

// Opus 4.8 and 5 share one rate. Both id spellings are listed because Anthropic
// writes the version with a dot while several relays normalise it to a dash, and
// a missed spelling would silently fall through to DEFAULT_RATE.
const ANTHROPIC_RATES: Array<[string, TokenRate]> = [
  ['claude-opus-5', { prompt: 5, completion: 25 }],
  ['claude-opus-4-8', { prompt: 5, completion: 25 }],
  ['claude-opus-4.8', { prompt: 5, completion: 25 }]
];

const RATES_BY_PROVIDER: Record<string, Array<[string, TokenRate]>> = {
  openai: OPENAI_RATES,
  anthropic: ANTHROPIC_RATES,
  xai: []
};

/**
 * Applied when a model has no published rate.
 *
 * Deliberately non-zero: billing an unknown model at 0 would let it consume an
 * unlimited quota without ever tripping a key's spend cap.
 */
export const DEFAULT_RATE: TokenRate = { prompt: 1, completion: 3 };

/** The published rate for a model, or null when none is on file. */
export function findTokenRate(provider: string, model: string): TokenRate | null {
  const id = String(model || '').trim().toLowerCase();
  if (!id) return null;

  const table = RATES_BY_PROVIDER[provider] ?? [];
  // Longest prefix wins so `gpt-5.5-pro` never resolves to the `gpt-5.5` rate.
  let best: { length: number; rate: TokenRate } | null = null;
  for (const [prefix, rate] of table) {
    if (id.startsWith(prefix) && (!best || prefix.length > best.length)) {
      best = { length: prefix.length, rate };
    }
  }
  return best?.rate ?? null;
}

/** USD for a token count at a given rate. */
export function priceTokens(tokens: number, ratePerMillion: number): number {
  const count = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  return (count / TOKENS_PER_UNIT) * ratePerMillion;
}
