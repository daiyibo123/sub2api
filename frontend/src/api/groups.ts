/**
 * Groups API endpoints (精简版)
 */

import { apiClient } from './client'
import type { Group } from '@/types'

export interface GroupCreate {
  name: string
  description?: string
  priority?: number
  error_threshold?: number
  error_count_threshold?: number
  window_seconds?: number
}

export const groupsAPI = {
  async list(): Promise<Group[]> {
    const { data } = await apiClient.get<Group[]>('/groups')
    return data
  },

  async create(params: GroupCreate): Promise<Group> {
    const { data } = await apiClient.post<{ data: Group }>('/groups', params)
    return data.data
  },

  async update(id: number, params: Partial<Group>): Promise<Group> {
    const { data } = await apiClient.put<{ data: Group }>(`/groups/${id}`, params)
    return data.data
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/groups/${id}`)
  }
}

export const userGroupsAPI = {
  list: groupsAPI.list,
  getAvailable: async (): Promise<Group[]> => {
    return []
  },
  getUserGroupRates: async (): Promise<any[]> => {
    return []
  }
}

export default groupsAPI
