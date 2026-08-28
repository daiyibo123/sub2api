// Provider-specific endpoint and credential details, shared by the gateway
// routes and the health-check probe so both talk to upstreams identically.

export const PROVIDERS = ['openai', 'anthropic', 'xai'] as const;

export type ProviderName = typeof PROVIDERS[number];

export function isProvider(value: unknown): value is ProviderName {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

export function providerLabel(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'Anthropic';
    case 'xai': return 'xAI';
    case 'openai': return 'OpenAI';
    default: return provider || 'unknown';
  }
}

export function getDefaultBaseUrl(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'https://api.anthropic.com';
    case 'xai': return 'https://api.x.ai';
    case 'openai':
    default: return 'https://api.openai.com';
  }
}

export function getProviderAuthHeaders(provider: string, apiKey: string): Record<string, string> {
  if (provider === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  }
  return { authorization: `Bearer ${apiKey}` };
}

/** A small model per provider, used only for liveness probes. */
export function getProbeModel(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'claude-3-5-haiku-20241022';
    case 'xai': return 'grok-2-latest';
    case 'openai':
    default: return 'gpt-4o-mini';
  }
}
