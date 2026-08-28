// Proxy utilities for forwarding requests to upstream providers
import { ProxyRequest, ProxyResponse } from '../types';

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
  // Find exact match first
  for (const mapping of mappings) {
    if (mapping.enabled && mapping.requested_model === requestedModel) {
      return mapping.upstream_model;
    }
  }
  
  // Find prefix match
  for (const mapping of mappings) {
    if (mapping.enabled && mapping.requested_model.endsWith('*')) {
      const prefix = mapping.requested_model.slice(0, -1);
      if (requestedModel.startsWith(prefix)) {
        return mapping.upstream_model + requestedModel.slice(prefix.length);
      }
    }
  }
  
  return requestedModel;
}
