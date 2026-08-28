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

export interface Channel {
  id: number;
  name: string;
  provider: string;
  base_url?: string;
  api_key?: string;
  enabled: number;
  priority: number;
  error_count: number;
  error_rate: number;
  last_error_at?: string;
  created_at: string;
}

export interface Account {
  id: number;
  name: string;
  provider: 'openai' | 'anthropic' | 'xai';
  api_key: string;
  base_url?: string;
  group_id: number;
  channel_id: number;
  enabled: number;
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
  name?: string;
  enabled: number;
  balance: number;
  quota_limit: number;
  created_at: string;
}

export interface UsageRecord {
  id: number;
  api_key_id?: number;
  model: string;
  provider: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number;
  status: number;
  error_message?: string;
  latency_ms?: number;
  created_at: string;
}

export interface RequestLog {
  id: number;
  account_id: number;
  channel_id: number;
  group_id: number;
  model: string;
  status: number;
  error_message?: string;
  latency_ms?: number;
  created_at: string;
}

export interface AccountErrorStats {
  accountId: number;
  channelId: number;
  groupId: number;
  windowStart: number;
  totalRequests: number;
  errorCount: number;
  errorRate: number;
  isUnhealthy: boolean;
}

export interface SelectAccountResult {
  account: Account;
  channel: Channel;
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
