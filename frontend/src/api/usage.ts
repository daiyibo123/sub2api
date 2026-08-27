/**
 * Usage tracking API endpoints (精简版)
 */

import { apiClient } from './client'

export interface UsageRecord {
  id: number
  api_key_id?: number
  model: string
  provider: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cost: number
  status: number
  error_message?: string
  latency_ms?: number
  created_at: string
}

export interface UserDashboardStats {
  total_cost: number
  total_requests: number
  total_input_tokens?: number
  total_output_tokens?: number
  total_cache_tokens?: number
  total_cache_read_tokens?: number
  total_cache_creation_tokens?: number
  period?: string
  models?: any[]
  endpoints?: any[]
}

export interface BatchApiKeyUsageStats {
  [key: string]: any
}

export interface UsageListResponse {
  items: UsageRecord[]
  total: number
  pages: number
}

export const usageAPI = {
  async list(limit = 100, offset = 0): Promise<UsageRecord[]> {
    const { data } = await apiClient.get<UsageRecord[]>('/usage', {
      params: { limit, offset }
    })
    return data
  },

  async query(_params: any, _options?: any): Promise<UsageListResponse> {
    return { items: [], total: 0, pages: 0 }
  },

  async getStats(_filters?: any): Promise<UserDashboardStats> {
    return {
      total_cost: 0,
      total_requests: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_creation_tokens: 0,
      period: '7d',
      models: [],
      endpoints: []
    }
  },

  async getDashboardTrend(): Promise<any[]> {
    return []
  },

  async getDashboardModels(_options?: any): Promise<any[]> {
    return []
  },

  async getByDateRange(_start: string, _end: string): Promise<UsageRecord[]> {
    return []
  },

  async getDashboardSnapshotV2(_options?: any): Promise<UserDashboardStats> {
    return {
      total_cost: 0,
      total_requests: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_creation_tokens: 0,
      period: '7d',
      models: [],
      endpoints: []
    }
  },

  async getDashboardApiKeysUsage(): Promise<any> {
    return {}
  },

  async listMyErrorRequests(_options?: any): Promise<UsageRecord[]> {
    return []
  },

  async getAvailable(): Promise<any[]> {
    return []
  },

  async getUserGroupRates(): Promise<any[]> {
    return []
  }
}

export type { UsageRecord, UserDashboardStats, BatchApiKeyUsageStats, UsageListResponse } from './usage'
