/**
 * Authentication API endpoints (精简版)
 * Handles simple password login only
 */

import { apiClient } from './client'

export interface LoginRequest {
  username: string
  password: string
}

export interface LoginResponse {
  token: string
  user: {
    id: number
    username: string
    is_admin: boolean
  }
}

export interface AuthResponse {
  token: string
  user: {
    id: number
    username: string
    is_admin: boolean
  }
}

export const authAPI = {
  /**
   * Login with username and password
   */
  async login(username: string, password: string): Promise<LoginResponse> {
    const { data } = await apiClient.post<LoginResponse>('/auth/login', {
      username,
      password
    })
    return data
  },

  /**
   * Logout
   */
  async logout(): Promise<void> {
    await apiClient.post('/auth/logout')
    localStorage.removeItem('auth_token')
    localStorage.removeItem('auth_user')
  }
}

export interface TotpLoginResponse {
  requires_totp: boolean
}

export type OAuthLoginStart = {
  url: string
}

export const buildOAuthLoginStartURL = (_provider: string): string => '#'
export const getPublicSettings = async () => ({})
export const isTotp2FARequired = async () => false
export const isWeChatWebOAuthEnabled = async () => false
export const startOAuthLogin = async (_provider: string) => ({})
