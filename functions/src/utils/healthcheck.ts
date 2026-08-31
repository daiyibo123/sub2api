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
  /** Which upstream model the probe exercised, empty for a listing-only probe. */
  model?: string;
  /** Billing weight reported by an upstream that exposes it. */
  rateMultiplier?: number;
}

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Ask an account's upstream which models it can serve.
 *
 * The dashboard uses this to populate the health-check dialog, so an operator
 * probes a model the upstream actually offers instead of a hard-coded guess
 * that a relay or restricted plan may reject.
 */
export async function listUpstreamModels(db: Database, accountId: number): Promise<{ id: string; name?: string }[]> {
  const account = await db.getAccount(accountId);
  if (!account) throw new Error('账号不存在');
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
    if (!response.ok) throw new Error(`获取模型失败（HTTP ${response.status}）`);
    let payload: any = null;
    try { payload = raw ? JSON.parse(raw) : null; } catch { payload = null; }
    const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    const models = rows.map((row: any) => ({ id: String(row.id || row.name || '').trim(), name: row.name ? String(row.name) : undefined }))
      .filter((row: { id: string }) => row.id);
    if (!models.length) throw new Error('上游没有返回可用模型');
    return models.slice(0, 200);
  } finally {
    clearTimeout(timer);
  }
}

/** Probe one account with the selected upstream model. */
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
  const model = String(selectedModel || '').trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();

  // Anthropic has no universally available model listing, so it is always
  // probed with a 1-token completion. For the OpenAI-compatible providers a
  // model listing is the cheapest liveness signal, but once an operator picks a
  // specific model the probe must actually exercise that model — a listing would
  // still pass for a model the plan cannot serve.
  const usesCompletion = isAnthropic || Boolean(model);
  const probeModel = model || getProbeModel(account.provider);
  const endpoint = usesCompletion
    ? (isAnthropic ? `${baseUrl}/v1/messages` : `${baseUrl}/v1/chat/completions`)
    : `${baseUrl}/v1/models`;
  const payload = isAnthropic
    ? { model: probeModel, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
    : { model: probeModel, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }], stream: false };

  try {
    const response = await fetch(endpoint, {
      method: usesCompletion ? 'POST' : 'GET',
      headers: { ...getProviderAuthHeaders(account.provider, apiKey), 'content-type': 'application/json' },
      body: usesCompletion ? JSON.stringify(payload) : undefined,
      signal: controller.signal
    });
    const latencyMs = Date.now() - startedAt;

    let detail = '';
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      try { detail = JSON.parse(raw)?.error?.message || ''; } catch { detail = raw.slice(0, 160); }
    }

    // Naming the probed model matters when a key is alive but the selected
    // model is not available: without it both cases read as "连接失败".
    const scope = usesCompletion ? `${probeModel} · ` : '';
    const result: HealthResult = {
      ...base,
      model: usesCompletion ? probeModel : '',
      success: response.ok,
      status: response.status,
      latencyMs,
      message: response.ok
        ? `${scope}连接成功（${latencyMs} ms）`
        : `${scope}连接失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`
    };
    await persist(db, result);
    return result;
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message = error instanceof Error && error.name === 'AbortError'
      ? `连接超时（${PROBE_TIMEOUT_MS / 1000} 秒）`
      : error instanceof Error ? error.message : '未知错误';
    const result: HealthResult = { ...base, success: false, status: 0, latencyMs, message };
    await persist(db, result);
    return result;
  } finally {
    clearTimeout(timer);
  }
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
