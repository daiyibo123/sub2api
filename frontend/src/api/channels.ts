/**
 * Channels API endpoints (精简版)
 */

import { apiClient } from './client'
import type { Channel } from '@/types'

export interface ChannelCreate {
  name: string
  provider: string
  base_url?: string
  api_key?: string
  priority?: number
}

export const channelsAPI = {
  async list(): Promise<Channel[]> {
    const { data } = await apiClient.get<Channel[]>('/channels')
    return data
  },

  async create(params: ChannelCreate): Promise<Channel> {
    const { data } = await apiClient.post<{ data: Channel }>('/channels', params)
    return data.data
  },

  async update(id: number, params: Partial<Channel>): Promise<Channel> {
    const { data } = await apiClient.put<{ data: Channel }>(`/channels/${id}`, params)
    return data.data
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/channels/${id}`)
  }
}

export const userChannelsAPI = {
  list: channelsAPI.list
}

export default channelsAPI
