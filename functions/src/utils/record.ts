// Shared request/usage bookkeeping for the gateway routes.
import type { Database } from '../db';
import type { FailoverManager } from '../failover';
import { calculateCost } from '../billing';
import { measureStreamTiming, StreamOutcome } from './proxy';
import { defer, Deferrable } from './background';

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
 * the record is written from the stream's completion callback.
 */
export function streamWithRecording(
  body: ReadableStream<Uint8Array>,
  status: number,
  headers: Record<string, string>,
  context: RecordContext
): Response {
  const isError = status >= 400;

  const measured = measureStreamTiming(body, context.startedAt, (outcome: StreamOutcome) => {
    const cost = isError ? 0 : calculateCost(
      context.provider,
      context.model,
      outcome.promptTokens,
      outcome.completionTokens
    ) * context.rateMultiplier;

    if (cost > 0) {
      defer(context.ctx, context.db.incrementApiKeyUsage(context.keyRecordId, cost));
    }

    defer(context.ctx, context.db.createUsageRecord({
      api_key_id: context.keyRecordId,
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
    }));

    defer(context.ctx, context.db.createRequestLog({
      account_id: context.accountId,
      group_id: context.groupId,
      model: context.model,
      status,
      error_message: isError ? 'Upstream error' : '',
      latency_ms: outcome.totalMs,
      ttft_ms: outcome.ttftMs ?? undefined
    }));
  });

  context.failover.recordRequest(context.accountId, context.groupId, isError);

  return new Response(measured, {
    status,
    headers: { ...headers, 'content-type': headers['content-type'] || 'text/event-stream' }
  });
}
