// Proxy utilities for forwarding requests to upstream providers
import { ProxyRequest, ProxyResponse, ModelMapping } from '../types';

export async function proxyRequest(request: ProxyRequest): Promise<ProxyResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout
  
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers as any,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'follow',
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    
    return {
      status: response.status,
      headers,
      body: response.body!,
      text: () => response.text()
    };
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

export function buildUpstreamHeaders(
  originalHeaders: Headers,
  provider: string,
  apiKey: string,
  baseUrl?: string,
  clientSpoofing?: string
): Record<string, string> {
  const headers: Record<string, string> = {};
  
  // Copy relevant headers
  const preserveHeaders = [
    'content-type',
    'anthropic-version',
    'anthropic-beta',
    'x-api-key',
    'authorization'
  ];
  
  originalHeaders.forEach((value, key) => {
    if (preserveHeaders.includes(key.toLowerCase())) {
      headers[key] = value;
    }
  });
  
  // Provider-specific headers
  switch (provider) {
    case 'anthropic':
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';
      headers['anthropic-beta'] = headers['anthropic-beta'] || 'prompt-caching-2024-12-16,code-execution-2025-05-14';
      delete headers['authorization'];
      break;
    case 'openai':
      headers['authorization'] = `Bearer ${apiKey}`;
      break;
    case 'xai':
      headers['authorization'] = `Bearer ${apiKey}`;
      break;
    default:
      headers['authorization'] = `Bearer ${apiKey}`;
  }
  
  // Apply client spoofing
  applyClientSpoofing(headers, provider, clientSpoofing);
  
  // Remove host header (will be set by fetch)
  delete headers['host'];
  delete headers['cf-connecting-ip'];
  delete headers['cf-ray'];
  delete headers['cf-visitor'];
  delete headers['x-forwarded-for'];
  
  return headers;
}

// Client spoofing presets
const CLIENT_SPOOFING_PRESETS: Record<string, Record<string, string>> = {
  'codex': {
    'user-agent': 'Codex CLI/0.1.0',
    'x-client-name': 'openai-cli',
    'x-client-version': '0.1.0'
  },
  'codex-ws': {
    'user-agent': 'Codex CLI/0.1.0 (WebSocket)',
    'x-client-name': 'openai-cli',
    'x-client-version': '0.1.0'
  },
  'claude-code': {
    'user-agent': 'claude-cli/1.0',
    'anthropic-beta': 'code-execution-2025-05-14,computer-use-2025-07-15'
  },
  'claude-code-ws': {
    'user-agent': 'claude-cli/1.0',
    'anthropic-beta': 'code-execution-2025-05-14,computer-use-2025-07-15,web-search-2025-07-15'
  },
  'grok': {
    'user-agent': 'xAI-Grok/1.0',
    'x-client-name': 'grok-cli',
    'x-client-version': '1.0'
  }
};

function applyClientSpoofing(headers: Record<string, string>, provider: string, clientSpoofing?: string): void {
  if (!clientSpoofing || clientSpoofing.trim() === '') {
    return;
  }
  
  // Check if it's a preset
  const preset = CLIENT_SPOOFING_PRESETS[clientSpoofing.toLowerCase()];
  if (preset) {
    for (const [key, value] of Object.entries(preset)) {
      // Skip anthropic-beta for non-anthropic providers
      if (key === 'anthropic-beta' && provider !== 'anthropic') {
        continue;
      }
      headers[key] = value;
    }
    return;
  }
  
  // Try to parse as JSON
  try {
    const customHeaders = JSON.parse(clientSpoofing);
    if (typeof customHeaders === 'object' && customHeaders !== null) {
      for (const [key, value] of Object.entries(customHeaders)) {
        if (typeof value === 'string') {
          headers[key] = value;
        }
      }
    }
  } catch {
    // Invalid JSON, ignore
  }
}

/**
 * Resolve the credentials a request should actually use. An account may leave
 * An account carries its own key and base URL. A blank base URL means the
 * default is applied later by getUpstreamBaseUrl.
 */
export function resolveUpstreamCredentials(
  account: { api_key?: string; base_url?: string }
): { apiKey: string; baseUrl: string } {
  return {
    apiKey: String(account?.api_key || '').trim(),
    baseUrl: String(account?.base_url || '').trim()
  };
}

export interface StreamOutcome {
  /** Milliseconds until the first upstream byte reached the client. */
  ttftMs: number | null;
  /** Milliseconds until the upstream closed the stream. */
  totalMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Forward a stream untouched while observing timing and token usage.
 *
 * Time to first token decides whether a client feels responsive, so it must be
 * measured without buffering: every chunk is enqueued immediately and only
 * timestamped on the way past. Buffering to measure would inflate the very
 * number being measured.
 *
 * Providers report usage in a late SSE frame (`message_delta` for Anthropic, a
 * final `usage` chunk for OpenAI). Rather than retain the whole transcript, only
 * a small rolling tail is kept so a usage object split across two chunks is
 * still parsed. `onDone` runs after the upstream closes, so the caller can log
 * without delaying delivery.
 */
export function measureStreamTiming(
  body: ReadableStream<Uint8Array>,
  startedAt: number,
  onDone: (outcome: StreamOutcome) => void
): ReadableStream<Uint8Array> {
  let ttftMs: number | null = null;
  let settled = false;
  let tail = '';
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const decoder = new TextDecoder();

  // Enough to hold a usage frame that straddles a chunk boundary, small enough
  // that a long conversation never accumulates memory in the isolate.
  const TAIL_LIMIT = 4096;

  const scan = (text: string) => {
    tail = (tail + text).slice(-TAIL_LIMIT);
    // Match both OpenAI (prompt_tokens/completion_tokens) and Anthropic
    // (input_tokens/output_tokens) spellings wherever they appear.
    const prompt = /"(?:prompt_tokens|input_tokens)"\s*:\s*(\d+)/g;
    const completion = /"(?:completion_tokens|output_tokens)"\s*:\s*(\d+)/g;
    const total = /"total_tokens"\s*:\s*(\d+)/g;
    for (let m = prompt.exec(tail); m; m = prompt.exec(tail)) {
      usage.promptTokens = Math.max(usage.promptTokens, Number(m[1]) || 0);
    }
    for (let m = completion.exec(tail); m; m = completion.exec(tail)) {
      // Anthropic emits a running output count, so the largest seen wins.
      usage.completionTokens = Math.max(usage.completionTokens, Number(m[1]) || 0);
    }
    for (let m = total.exec(tail); m; m = total.exec(tail)) {
      usage.totalTokens = Math.max(usage.totalTokens, Number(m[1]) || 0);
    }
  };

  const finish = () => {
    if (settled) return;
    settled = true;
    try {
      onDone({
        ttftMs,
        totalMs: Date.now() - startedAt,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens || usage.promptTokens + usage.completionTokens
      });
    } catch {
      // Never let logging break the response the client is reading.
    }
  };

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Deliver first, measure second: the client must never wait on bookkeeping.
      controller.enqueue(chunk);
      if (ttftMs === null) ttftMs = Date.now() - startedAt;
      try {
        scan(decoder.decode(chunk, { stream: true }));
      } catch {
        // Binary or malformed frame; timing is still valid.
      }
    },
    flush() {
      finish();
    },
    cancel() {
      // The client disconnected mid-stream; still record what was observed.
      finish();
    }
  }));
}

/**
 * Billing weight for an account; 1 when unset or invalid.
 *
 * A reseller upstream may bill at a fraction (or a premium) of list price, so
 * cost is the raw token price scaled by this factor.
 *
 * A null column has to be rejected before the numeric check, not by it, because
 * `Number(null)` is 0 — a legal weight meaning "free". A database row created
 * before rate_multiplier existed would otherwise bill at zero and, because this
 * value also breaks ties in account selection, sort as the cheapest upstream and
 * win every request. An explicit 0 is still honoured: a free upstream is real.
 */
export function accountRateMultiplier(account: any): number {
  const raw = account?.rate_multiplier;
  if (raw === null || raw === undefined || raw === '') return 1;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 1;
}

export function getUpstreamBaseUrl(baseUrl?: string, provider?: string): string {
  if (baseUrl && baseUrl.trim()) {
    return baseUrl.replace(/\/$/, '');
  }
  
  switch (provider) {
    case 'anthropic':
      return 'https://api.anthropic.com';
    case 'xai':
      return 'https://api.x.ai';
    case 'openai':
    default:
      return 'https://api.openai.com';
  }
}

export function mapModel(requestedModel: string, mappings: any[]): string {
  const mapping = findModelMapping(requestedModel, mappings);
  if (!mapping) return requestedModel;
  if (mapping.requested_model.endsWith('*')) {
    const prefix = mapping.requested_model.slice(0, -1);
    return mapping.upstream_model + requestedModel.slice(prefix.length);
  }
  return mapping.upstream_model;
}

/** Resolve the selected mapping so routing can also honor its target group. */
export function findModelMapping(
  requestedModel: string,
  mappings: ModelMapping[],
  provider?: string
): ModelMapping | null {
  const enabled = mappings
    .filter(mapping => mapping.enabled && (!provider || mapping.provider === provider))
    .sort((a, b) => (a.priority - b.priority) || (a.id - b.id));

  const exact = enabled.find(mapping => mapping.requested_model === requestedModel);
  if (exact) return exact;

  return enabled.find(mapping => {
    if (!mapping.requested_model.endsWith('*')) return false;
    return requestedModel.startsWith(mapping.requested_model.slice(0, -1));
  }) || null;
}
