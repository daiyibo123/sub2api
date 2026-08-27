/**
 * Pinia Stores Export (精简版)
 * Central export point for all application stores
 */

export { useAuthStore } from './auth'
export { useAppStore } from './app'

// Re-export types for convenience
export type { User, LoginRequest, AuthResponse } from '@/types'
export type { Toast, ToastType, AppState } from '@/types'
