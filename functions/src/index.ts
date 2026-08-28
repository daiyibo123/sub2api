/** Bindings available to the Pages Function worker. */
export interface Env {
  DB: D1Database;
  CONFIG_KV?: KVNamespace;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  JWT_SECRET?: string;
  ERROR_RATE_THRESHOLD?: string;
  ERROR_COUNT_THRESHOLD?: string;
  WINDOW_SECONDS?: string;
  MAX_SAME_ACCOUNT_RETRIES?: string;
}
