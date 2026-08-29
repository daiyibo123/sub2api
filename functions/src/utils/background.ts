// Keeping deferred work alive past the Response.
//
// A Worker isolate may be torn down the moment its Response is returned. Any
// promise that is merely started — `db.createUsageRecord(...).catch(...)` — is
// dropped at that point, so usage records, request logs and quota increments
// silently never reach D1. Locally this is invisible because miniflare keeps the
// process running, which is why it only shows up in production.
//
// `ctx.waitUntil` is the runtime's contract for "finish this before you die",
// so every fire-and-forget write must go through here.

/** The slice of ExecutionContext we depend on, so tests can pass a stub. */
export interface Deferrable {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Register background work with the runtime.
 *
 * Errors are swallowed on purpose: this is telemetry, and a failed log must
 * never turn a successful proxied request into an error for the caller. When no
 * context is available the promise is still attached to a catch handler so it
 * cannot surface as an unhandled rejection.
 */
export function defer(ctx: Deferrable | undefined, work: Promise<unknown>): void {
  const guarded = work.catch(() => {});
  if (ctx?.waitUntil) {
    ctx.waitUntil(guarded);
  }
}

/** Register several writes at once. */
export function deferAll(ctx: Deferrable | undefined, work: Array<Promise<unknown>>): void {
  for (const item of work) defer(ctx, item);
}
