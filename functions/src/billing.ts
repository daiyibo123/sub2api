// Token counting and billing utilities
import { findTokenRate, priceTokens, DEFAULT_RATE } from './pricing';

// Simple token estimation (chars / 4 for English, chars / 2 for CJK)
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    // CJK characters
    if ((code >= 0x4E00 && code <= 0x9FFF) || 
        (code >= 0x3400 && code <= 0x4DBF) ||
        (code >= 0x3000 && code <= 0x303F)) {
      tokens += 2;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

// Extract token usage from response headers or body
export function extractTokenUsage(body: any, headers: Headers | Record<string, string>): { promptTokens: number; completionTokens: number; totalTokens: number } {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  
  // Try to get from body first
  if (body?.usage) {
    promptTokens = body.usage.prompt_tokens || body.usage.input_tokens || 0;
    completionTokens = body.usage.completion_tokens || body.usage.output_tokens || 0;
    totalTokens = body.usage.total_tokens || (promptTokens + completionTokens);
  }
  
  // Fallback to estimation
  if (totalTokens === 0) {
    const inputText = typeof body?.messages === 'string' ? body.messages : JSON.stringify(body?.messages || body?.input || '');
    const outputText = typeof body?.output === 'string' ? body.output : JSON.stringify(body?.output || body?.content || '');
    promptTokens = estimateTokens(inputText);
    completionTokens = estimateTokens(outputText);
    totalTokens = promptTokens + completionTokens;
  }
  
  return { promptTokens, completionTokens, totalTokens };
}

export interface CostBreakdown {
  baseCost: number;
  cost: number;
  multiplier: number;
  estimated: boolean;
}

export function calculateCostBreakdown(provider: string, model: string, promptTokens: number, completionTokens: number, multiplier = 1): CostBreakdown {
  const published = findTokenRate(provider, model);
  const rates = published || DEFAULT_RATE;

  // priceTokens divides by 1,000,000 because the table is per-1M. The previous
  // implementation divided by 1,000 against the same per-1M figures, so every
  // recorded cost — and every quota decrement — was 1000x too large.
  const raw = priceTokens(promptTokens, rates.prompt) + priceTokens(completionTokens, rates.completion);
  const baseCost = round6(raw);
  const safeMultiplier = readMultiplier(multiplier);
  return {
    baseCost,
    cost: round6(baseCost * safeMultiplier),
    multiplier: safeMultiplier,
    estimated: !published
  };
}

/**
 * Coerce a billing weight, falling back to 1x for anything unusable.
 *
 * `null` has to be rejected before the numeric check rather than by it, because
 * `Number(null)` is 0 — a legal weight meaning "free". An account whose
 * rate_multiplier column was never populated would therefore have billed every
 * request at zero and never consumed its key's quota. 0 is still honoured when
 * it is written explicitly, since a genuinely free upstream is a real case.
 */
function readMultiplier(value: unknown): number {
  if (value === null || value === undefined || value === '') return 1;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
}

/** Six decimals: sub-cent accuracy without accumulating float noise. */
function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// Calculate cost based on model and provider
export function calculateCost(provider: string, model: string, promptTokens: number, completionTokens: number): number {
  return calculateCostBreakdown(provider, model, promptTokens, completionTokens).baseCost;
}
