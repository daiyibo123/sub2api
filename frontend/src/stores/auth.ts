/**
 * Authentication Store (精简版)
 * 仅保留密码登录，无 OAuth、TOTP、Passkey
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { authAPI, type LoginResponse } from '@/api'
import type { User } from '@/types'

const AUTH_TOKEN_KEY = 'auth_token'
const AUTH_USER_KEY = 'auth_user'

export const useAuthStore = defineStore('auth', () => {
  // ==================== State ====================
  const token = ref<string | null>(localStorage.getItem(AUTH_TOKEN_KEY))
  const user = ref<User | null>(null)
  const isAdmin = ref(false)
  const isAuthenticated = computed(() => !!token.value && !!user.value)

  // ==================== Actions ====================
  async function login(username: string, password: string): Promise<boolean> {
    try {
      const response: LoginResponse = await authAPI.login(username, password)
      
      token.value = response.token
      user.value = response.user
      isAdmin.value = response.user.is_admin || false
      
      localStorage.setItem(AUTH_TOKEN_KEY, response.token)
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(response.user))
      
      return true
    } catch (error) {
      console.error('Login failed:', error)
      return false
    }
  }

  function logout() {
    token.value = null
    user.value = null
    isAdmin.value = false
    localStorage.removeItem(AUTH_TOKEN_KEY)
    localStorage.removeItem(AUTH_USER_KEY)
  }

  function checkAuth() {
    const savedToken = localStorage.getItem(AUTH_TOKEN_KEY)
    const savedUser = localStorage.getItem(AUTH_USER_KEY)
    
    if (savedToken && savedUser) {
      try {
        token.value = savedToken
        user.value = JSON.parse(savedUser)
        isAdmin.value = user.value?.is_admin || false
      } catch {
        logout()
      }
    }
  }

  // ==================== Getters ====================
  const isAuthenticatedGetter = computed(() => !!token.value && !!user.value)
  const isAdminGetter = computed(() => isAdmin.value)
  const isSimpleMode = computed(() => false)

  // ==================== Actions ====================
  async function loginWithPasskey(): Promise<boolean> {
    return false
  }

  async function login2FA(_code: string): Promise<boolean> {
    return false
  }

  return {
    // State
    token,
    user,
    isAdmin,
    // Getters
    isAuthenticated: isAuthenticatedGetter,
    isAdmin: isAdminGetter,
    isSimpleMode,
    // Actions
    login,
    logout,
    checkAuth,
    loginWithPasskey,
    login2FA
  }
})
