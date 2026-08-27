/**
 * API Client for Sub2API Backend (精简版)
 * Central export point for all API modules
 */

// Re-export the HTTP client
export { apiClient } from './client'

// Auth API
export { authAPI, type LoginResponse } from './auth'

// User APIs
export { keysAPI } from './keys'
export { usageAPI } from './usage'
export { userGroupsAPI } from './groups'
export { userChannelsAPI } from './channels'

// Default export
export { default } from './client'
