// Upstream liveness probing (账号测活).
import type { Database } from '../db';
import { getDefaultBaseUrl, getProviderAuthHeaders, getProbeModel } from './provider';

export interface HealthResult {
  accountId: number;
  name: string;
  provider: string;
  success: boolean;
  status: number;
  latencyMs: number;
  message: string;
  /** Which upstream model the probe exercised. */
  model?: string;
  /** Milliseconds until the first streamed chunk arrived. */
  ttftMs?: number;
  /** Billing weight reported by an upstream that exposes it. */
  rateMultiplier?: number;
}

export interface UpstreamModel {
  id: string;
  name?: string;
}

const PROBE_TIMEOUT_MS = 15_000;

/** Cached lists older than this are refetched on the next dialog open. */
const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The probe prompt.
 *
 * Short and deterministic: the probe only needs to prove that the credential is
 * accepted and that the model produces tokens, so a longer prompt would just
 * cost more for the same answer.
 */
const PROBE_PROMPT = '1+1=?';

/** Cap on generated tokens. Enough for a real reply, cheap enough to run often. */
const PROBE_MAX_TOKENS = 16;

/**
 * Read an account's cached model list.
 *
 * Returns null when nothing usable is stored, which is what makes the caller
 * fall through to a live fetch.
 */
export function readCachedModels(account: any): { models: UpstreamModel[]; fetchedAt: string } | null {
  const raw = String(account?.upstream_models || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const models = parsed
      .map((row: any) => ({ id: String(row?.id || '').trim(), name: row?.name ? String(row.name) : undefined }))
      .filter((row: UpstreamModel) => row.id);
    if (!models.length) return null;
    return { models, fetchedAt: String(account?.upstream_models_at || '') };
  } catch {
    return null;
  }
}

function isStale(fetchedAt: string): boolean {
  if (!fetchedAt) return true;
  // SQLite stores "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker, so it is
  // spelled out here; parsing it as local time would skew the age by the
  // operator's offset and could mark a fresh list stale.
  const parsed = Date.parse(`${fetchedAt.replace(' ', 'T')}Z`);
  if (!Number.isFinite(parsed)) return true;
  return Date.now() - parsed > MODEL_CACHE_TTL_MS;
}

/**
 * Ask an account's upstream which models it can serve, and remember the answer.
 *
 * The list is persisted so reopening the dialog does not require another
 * upstream round trip: a provider's catalogue changes on the order of weeks, but
 * an operator may test an account several times in a minute. `refresh` forces a
 * live fetch for the case where the upstream really did change.
 */
export async function listUpstreamModels(
  db: Database,
  accountId: number,
  refresh = false
): Promise<{ models: UpstreamModel[]; cached: boolean; fetchedAt: string }> {
  const account = await db.getAccount(accountId);
  if (!account) throw new Error('账号不存在');

  const cached = readCachedModels(account);
  if (cached && !refresh && !isStale(cached.fetchedAt)) {
    return { models: cached.models, cached: true, fetchedAt: cached.fetchedAt };
  }

  const apiKey = String(account.api_key || '').trim();
  if (!apiKey) throw new Error('账号没有配置密钥');
  const baseUrl = (String(account.base_url || '').trim() || getDefaultBaseUrl(account.provider)).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      method: 'GET',
      headers: getProviderAuthHeaders(account.provider, apiKey),
      signal: controller.signal
    });
    const raw = await response.text().catch(() => '');
    if (!response.ok) {
      // A stale list still lets the operator pick a model and test, which beats
      // an empty dialog when the listing endpoint is the only thing broken.
      if (cached) return { models: cached.models, cached: true, fetchedAt: cached.fetchedAt };
      throw new Error(`获取模型失败（HTTP ${response.status}）`);
    }
    let payload: any = null;
    try { payload = raw ? JSON.parse(raw) : null; } catch { payload = null; }
    const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    const models: UpstreamModel[] = rows
      .map((row: any) => ({ id: String(row.id || row.name || '').trim(), name: row.name ? String(row.name) : undefined }))
      .filter((row: UpstreamModel) => row.id)
      .slice(0, 200);
    if (!models.length) {
      if (cached) return { models: cached.models, cached: true, fetchedAt: cached.fetchedAt };
      throw new Error('上游没有返回可用模型');
    }

    await db.saveUpstreamModels(accountId, models).catch(() => {});
    const stored = await db.getAccount(accountId);
    return { models, cached: false, fetchedAt: String(stored?.upstream_models_at || '') };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve which model to probe an account with.
 *
 * Precedence is explicit choice, then the model this account was last verified
 * against, then the provider default. The remembered model is what makes a batch
 * probe meaningful: keeping an account alive with a model it cannot serve would
 * report a failure that says nothing about the credential.
 */
export function resolveProbeModel(account: any, selectedModel?: string): string {
  const explicit = String(selectedModel || '').trim();
  if (explicit) return explicit;
  const remembered = String(account?.probe_model || '').trim();
  if (remembered) return remembered;
  return getProbeModel(account?.provider);
}

/**
 * Probe one account with a streaming completion.
 *
 * Streaming is the point rather than an implementation detail: a non-streaming
 * probe only proves the request was accepted, while real client traffic here is
 * predominantly SSE. An upstream can accept a buffered request and still fail to
 * stream — a relay that never flushes, or a plan without streaming rights — so
 * only a streamed probe verifies the path the gateway actually uses. It also
 * yields a real time-to-first-token, which is the number that matters for
 * latency.
 */
export async function probeAccount(db: Database, accountId: number, selectedModel?: string): Promise<HealthResult> {
  const account = await db.getAccount(accountId);
  if (!account) {
    return {
      accountId, name: `#${accountId}`, provider: '', success: false,
      status: 0, latencyMs: 0, message: '账号不存在'
    };
  }

  const base = {
    accountId,
    name: String(account.name || `#${accountId}`),
    provider: String(account.provider || '')
  };

  const apiKey = String(account.api_key || '').trim();
  if (!apiKey) {
    const result = { ...base, success: false, status: 0, latencyMs: 0, message: '账号没有配置密钥' };
    await persist(db, result);
    return result;
  }

  const baseUrl = (String(account.base_url || '').trim()
    || getDefaultBaseUrl(account.provider)).replace(/\/+$/, '');

  const isAnthropic = account.provider === 'anthropic';
  const probeModel = resolveProbeModel(account, selectedModel);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();

  const endpoint = isAnthropic ? `${baseUrl}/v1/messages` : `${baseUrl}/v1/chat/completions`;
  const payload = {
    model: probeModel,
    max_tokens: PROBE_MAX_TOKENS,
    stream: true,
    messages: [{ role: 'user', content: PROBE_PROMPT }]
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...getProviderAuthHeaders(account.provider, apiKey),
        'content-type': 'application/json',
        accept: 'text/event-stream'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      let detail = '';
      try { detail = JSON.parse(raw)?.error?.message || ''; } catch { detail = raw.slice(0, 160); }
      const result: HealthResult = {
        ...base,
        model: probeModel,
        success: false,
        status: response.status,
        latencyMs: Date.now() - startedAt,
        message: `${probeModel} · 连接失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`
      };
      await persist(db, result);
      return result;
    }

    // A 200 with no body still means no tokens were produced, so success is
    // decided by what actually arrives on the stream, not by the status alone.
    const stream = await readProbeStream(response, startedAt);
    const latencyMs = Date.now() - startedAt;

    if (!stream.received) {
      const result: HealthResult = {
        ...base,
        model: probeModel,
        success: false,
        status: response.status,
        latencyMs,
        message: `${probeModel} · 上游返回 200 但没有推送任何流式内容`
      };
      await persist(db, result);
      return result;
    }

    const ttft = stream.ttftMs ?? latencyMs;
    const result: HealthResult = {
      ...base,
      model: probeModel,
      success: true,
      status: response.status,
      latencyMs,
      ttftMs: ttft,
      message: `${probeModel} · 流式连接成功（首字 ${ttft} ms，共 ${latencyMs} ms）`
    };
    await persist(db, result);
    // Remember the model only on success: storing a model that just failed would
    // make every later batch probe repeat the same failure.
    await db.saveProbeModel(accountId, probeModel).catch(() => {});
    return result;
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message = error instanceof Error && error.name === 'AbortError'
      ? `${probeModel} · 连接超时（${PROBE_TIMEOUT_MS / 1000} 秒）`
      : `${probeModel} · ${error instanceof Error ? error.message : '未知错误'}`;
    const result: HealthResult = { ...base, model: probeModel, success: false, status: 0, latencyMs, message };
    await persist(db, result);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Consume just enough of an SSE body to prove tokens are flowing.
 *
 * The stream is cancelled after the first payload chunk: waiting for the whole
 * completion would bill more tokens and add latency without changing the
 * verdict. Keep-alive comments and the terminal `[DONE]` marker are not evidence
 * of generation, so they do not count as a first chunk.
 */
async function readProbeStream(response: Response, startedAt: number): Promise<{ received: boolean; ttftMs: number | null }> {
  if (!response.body) return { received: false, ttftMs: null };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });

      for (const line of buffered.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        return { received: true, ttftMs: Date.now() - startedAt };
      }

      // Guard against an upstream that streams unbounded comment padding.
      if (buffered.length > 64_000) break;
    }
  } catch {
    // A mid-stream failure is still a failed probe; fall through to the caller.
  } finally {
    await reader.cancel().catch(() => {});
  }

  return { received: false, ttftMs: null };
}

/**
 * Probe several accounts with bounded concurrency.
 *
 * Workers cap simultaneous outbound connections per request, and a large fleet
 * probed all at once would also hit upstream rate limits, so a small window is
 * used rather than one giant `Promise.all`.
 */
export async function probeAccounts(db: Database, accountIds: number[], concurrency = 4, selectedModels?: Record<number, string>): Promise<HealthResult[]> {
  const results: HealthResult[] = [];
  const queue = [...accountIds];

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      results.push(await probeAccount(db, id, selectedModels?.[id]));
    }
  });

  await Promise.all(workers);
  // Preserve the caller's ordering so the console shows rows in table order.
  return accountIds
    .map(id => results.find(entry => entry.accountId === id))
    .filter((entry): entry is HealthResult => Boolean(entry));
}

async function persist(db: Database, result: HealthResult): Promise<void> {
  await db.recordAccountHealthCheck(result.accountId, result.success, result.latencyMs, result.message)
    .catch(() => {});
}
