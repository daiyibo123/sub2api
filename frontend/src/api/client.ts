/**
 * Axios HTTP Client Configuration (精简版)
 * Simple client for the new Cloudflare Functions backend
 */

import axios, { AxiosInstance, AxiosError } from 'axios'
import type { ApiResponse } from '@/types'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1'

export const apiClient: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
})

// Request interceptor: attach token
apiClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('auth_token')
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => Promise.reject(error)
)

// Response interceptor: unwrap { code, message, data } or pass through
apiClient.interceptors.response.use(
  (response) => {
    const apiResponse = response.data as ApiResponse<unknown>
    if (apiResponse && typeof apiResponse === 'object' && 'code' in apiResponse) {
      if (apiResponse.code === 0) {
        response.data = apiResponse.data
      } else {
        return Promise.reject({
          status: response.status,
          code: apiResponse.code,
          message: apiResponse.message || 'Unknown error',
        })
      }
    }
    return response
  },
  (error: AxiosError<ApiResponse<unknown>>) => {
    if (error.response) {
      const { status, data } = error.response
      const apiData = (typeof data === 'object' && data !== null ? data : {}) as Record<string, any>
      
      if (status === 401) {
        localStorage.removeItem('auth_token')
        localStorage.removeItem('auth_user')
        if (window.location.pathname !== '/login') {
          window.location.href = '/login'
        }
      }
      
      return Promise.reject({
        status,
        code: apiData.code,
        message: apiData.message || error.message,
      })
    }
    
    return Promise.reject({
      status: 0,
      code: 'NETWORK_ERROR',
      message: error.message || 'Network error',
    })
  }
)

export default apiClient
