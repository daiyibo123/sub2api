/**
 * API Keys management endpoints (精简版)
 */

import { apiClient } from './client'

export interface ApiKey {
  id: number
  name?: string
  enabled: number
  balance: number
  quota_limit: number
  created_at: string
}

export interface CreateApiKeyRequest {
  name?: string
  quota_limit?: number
}

export const keysAPI = {
  async list(): Promise<ApiKey[]> {
    const { data } = await apiClient.get<ApiKey[]>('/keys')
    return data
  },

  async create(params: CreateApiKeyRequest): Promise<{ data: ApiKey & { key: string } }> {
    const { data } = await apiClient.post<{ data: ApiKey & { key: string } }>('/keys', params)
    return data
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/keys/${id}`)
  },

  async toggleStatus(_id: number): Promise<void> {
    // stub
  },

  async update(_id: number, _params: Partial<ApiKey>): Promise<void> {
    // stub
  }
}

export { type ApiKey, type CreateApiKeyRequest }
