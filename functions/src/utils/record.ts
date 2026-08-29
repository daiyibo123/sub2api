// Shared request/usage bookkeeping for the gateway routes.
import type { Database } from '../db';
import type { FailoverManager } from '../failover';
import { calculateCost } from '../billing';
import { measureStreamTiming, StreamOutcome } from './proxy';
import { Deferrable } from './background';

/** Upper bound on how long the post-response bookkeeping may wait for a stream. */
const STREAM_RECORD_TIMEOUT_MS = 15 * 60 * 1000;

export interface RecordContext {
  db: Database;
  failover: FailoverManager;
  keyRecordId: number;
  accountId: number;
  groupId: number;
  provider: string;
  model: string;
  rateMultiplier: number;
  startedAt: number;
  /** Keeps the post-stream writes alive after the Response is returned. */
  ctx?: Deferrable;
}

/**
 * Wrap a streaming upstream response so usage is recorded when it finishes.
 *
 * Streaming used to write only a request log, never a usage record, so every
 * streamed call — the default for chat clients — was missing from the usage page,
 * the dashboard totals and quota accounting. The body is forwarded unbuffered;
 * the record is written once the upstream closes.
 *
 * The `waitUntil` registration has to happen here, synchronously, before the
 * Response is handed back. Calling it from the stream's completion callback
 * throws, because by then the fetch handler has already returned and the
 * runtime refuses to extend a request that is over.
 */
export function streamWithRecording(
  body: ReadableStream<Uint8Array>,
  status: number,
  headers: Record<string, string>,
  context: RecordContext
): Response {
  const isError = status >= 400;

  // Resolved by the stream's flush/cancel handler below.
  let settle: (outcome: StreamOutcome) => void;
  const finished = new Promise<StreamOutcome>(resolve => { settle = resolve; });

  const measured = measureStreamTiming(body, context.startedAt, outcome => settle(outcome));

  // A stream that is never drained — an abandoned connection, or a runtime that
  // does not deliver the transformer's cancel callback — would leave `finished`
  // pending forever, and a `waitUntil` promise that never settles holds the
  // request open until the edge kills it. Cap the wait so the isolate is always
  // released; a partial record is better than a dropped request. The timer is
  // cleared on the normal path so a finished request leaves nothing pending.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<StreamOutcome>(resolve => {
    timer = setTimeout(
      () => resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0, ttftMs: null, totalMs: Date.now() - context.startedAt }),
      STREAM_RECORD_TIMEOUT_MS
    );
  });
  const settled = Promise.race([finished, timeout]).then(outcome => {
    if (timer !== undefined) clearTimeout(timer);
    return outcome;
  });

  const persist = settled.then(async outcome => {
    const cost = isError ? 0 : calculateCost(
      context.provider,
      context.model,
      outcome.promptTokens,
      outcome.completionTokens
    ) * context.rateMultiplier;

    if (cost > 0) {
      await context.db.incrementApiKeyUsage(context.keyRecordId, cost).catch(() => {});
    }

    await context.db.createUsageRecord({
      api_key_id: context.keyRecordId,
      group_id: context.groupId,
      account_id: context.accountId,
      model: context.model,
      provider: context.provider,
      prompt_tokens: outcome.promptTokens,
      completion_tokens: outcome.completionTokens,
      total_tokens: outcome.totalTokens,
      cost,
      status,
      error_message: isError ? 'Upstream error' : '',
      latency_ms: outcome.totalMs,
      ttft_ms: outcome.ttftMs ?? undefined
    }).catch(() => {});

    await context.db.createRequestLog({
      account_id: context.accountId,
      group_id: context.groupId,
      model: context.model,
      status,
      error_message: isError ? 'Upstream error' : '',
      latency_ms: outcome.totalMs,
      ttft_ms: outcome.ttftMs ?? undefined
    }).catch(() => {});
  }).catch(() => {
    // Telemetry must never surface as a failure to the caller.
  });

  // Registered while the handler is still running, so the isolate stays alive
  // until the stream drains and the records land.
  context.ctx?.waitUntil?.(persist);

  context.failover.recordRequest(context.accountId, context.groupId, isError);

  return new Response(measured, {
    status,
    headers: { ...headers, 'content-type': headers['content-type'] || 'text/event-stream' }
  });
}
