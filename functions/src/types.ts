// Core types for Sub2API Gateway

export interface User {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
}

export interface Group {
  id: number;
  name: string;
  description?: string;
  enabled: number;
  priority: number;
  error_threshold: number;
  error_count_threshold: number;
  window_seconds: number;
  created_at: string;
}

export interface Account {
  id: number;
  name: string;
  provider: 'openai' | 'anthropic' | 'xai';
  api_key: string;
  base_url?: string;
  group_id: number;
  /** Legacy column retained by the migration; no longer used for routing. */
  channel_id?: number;
  enabled: number;
  rate_multiplier?: number;
  error_count: number;
  error_rate: number;
  last_error_at?: string;
  last_error_msg?: string;
  priority: number;
  client_spoofing?: string;
  created_at: string;
}

export interface ModelMapping {
  id: number;
  requested_model: string;
  provider: string;
  upstream_model: string;
  group_id: number;
  enabled: number;
  priority: number;
}

export interface ApiKey {
  id: number;
  key_hash: string;
  /** Encrypted value for administrator-only copy; never returned by list APIs. */
  key_ciphertext?: string | null;
  name?: string;
  enabled: number;
  balance: number;
  quota_limit: number;
  group_id?: number | null;
  fallback_group_id?: number | null;
  created_at: string;
}

export interface UsageRecord {
  id: number;
  api_key_id?: number;
  /** Which group and account served the call, so usage can be filtered by them. */
  group_id?: number | null;
  account_id?: number | null;
  model: string;
  provider: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number;
  base_cost?: number;
  rate_multiplier?: number;
  cost_estimated?: number | boolean;
  cache_status?: string | null;
  status: number;
  error_message?: string;
  latency_ms?: number;
  /** Time to first byte. Null for non-streaming replies, which have no TTFT. */
  ttft_ms?: number | null;
  created_at: string;
}

export interface RequestLog {
  id: number;
  account_id: number;
  /** Retained for historical rows written before channels were removed. */
  channel_id?: number;
  group_id: number;
  model: string;
  status: number;
  error_message?: string;
  latency_ms?: number;
  ttft_ms?: number | null;
  created_at: string;
}

export interface AccountErrorStats {
  accountId: number;
  groupId: number;
  windowStart: number;
  totalRequests: number;
  errorCount: number;
  errorRate: number;
  isUnhealthy: boolean;
}

export interface SelectAccountResult {
  account: Account;
  group: Group;
  stats: AccountErrorStats | null;
}

export interface ProxyRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: ReadableStream | null;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream;
  text(): Promise<string>;
}
