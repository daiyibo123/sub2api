/**
 * Accounts API endpoints (精简版)
 */

import { apiClient } from './client'
import type { Account } from '@/types'

export interface AccountCreate {
  name: string
  provider: string
  api_key: string
  group_id: number
  channel_id: number
  base_url?: string
  priority?: number
}

export const accountsAPI = {
  async list(): Promise<Account[]> {
    const { data } = await apiClient.get<Account[]>('/accounts')
    return data
  },

  async create(params: AccountCreate): Promise<Account> {
    const { data } = await apiClient.post<{ data: Account }>('/accounts', params)
    return data.data
  },

  async update(id: number, params: Partial<Account>): Promise<Account> {
    const { data } = await apiClient.put<{ data: Account }>(`/accounts/${id}`, params)
    return data.data
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/accounts/${id}`)
  },

  async test(id: number): Promise<{ success: boolean; status?: number; message?: string }> {
    const { data } = await apiClient.post<{ success: boolean; status?: number; message?: string }>(`/accounts/${id}/test`)
    return data
  }
}

export default accountsAPI
