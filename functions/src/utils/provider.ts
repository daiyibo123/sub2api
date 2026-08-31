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

/**
 * The model a liveness probe uses for a provider.
 *
 * These are the models this deployment actually serves, so a probe failure means
 * the credential is dead rather than that the plan never offered the model.
 * Batch probing is driven entirely by this: an account is checked with its
 * provider's default, which keeps a keep-alive run predictable instead of
 * depending on whatever model an operator last happened to pick.
 */
export function getProbeModel(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'claude-opus-5';
    case 'xai': return 'grok-2-latest';
    case 'openai':
    default: return 'gpt-5.6-terra';
  }
}
