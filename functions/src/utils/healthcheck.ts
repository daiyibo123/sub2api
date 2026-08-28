// Upstream liveness probing (账号测活).
import type { Database } from '../db';
import { getDefaultBaseUrl, getProviderAuthHeaders } from './provider';

export interface HealthResult {
  accountId: number;
  name: string;
  provider: string;
  success: boolean;
  status: number;
  latencyMs: number;
  message: string;
  /** Billing weight reported by an upstream that exposes it. */
  rateMultiplier?: number;
}

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Probe one account and persist the outcome.
 *
 * The probe deliberately mirrors what the gateway actually forwards, including
 * so a passing probe means real traffic would take the same route and use the
 * same credential.
 *
 * Unlike a bare `GET /v1/models`, Anthropic is probed with a 1-token completion
 * because not every plan exposes a model listing, and a 404 there would look
 * like a dead key.
 */
export async function probeAccount(db: Database, accountId: number): Promise<HealthResult> {
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(
      isAnthropic ? `${baseUrl}/v1/messages` : `${baseUrl}/v1/models`,
      {
        method: isAnthropic ? 'POST' : 'GET',
        headers: { ...getProviderAuthHeaders(account.provider, apiKey), 'content-type': 'application/json' },
        body: isAnthropic ? JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }]
        }) : undefined,
        signal: controller.signal
      }
    );
    const latencyMs = Date.now() - startedAt;

    let detail = '';
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      try { detail = JSON.parse(raw)?.error?.message || ''; } catch { detail = raw.slice(0, 160); }
    }

    const result: HealthResult = {
      ...base,
      success: response.ok,
      status: response.status,
      latencyMs,
      message: response.ok
        ? `连接成功（${latencyMs} ms）`
        : `连接失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`
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
export async function probeAccounts(db: Database, accountIds: number[], concurrency = 4): Promise<HealthResult[]> {
  const results: HealthResult[] = [];
  const queue = [...accountIds];

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      results.push(await probeAccount(db, id));
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
