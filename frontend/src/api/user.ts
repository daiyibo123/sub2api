// User API stubs for simplified deployment
import type { User, LoginRequest, LoginResponse } from '@/types'

export const userAPI = {
  login: async (_data: LoginRequest): Promise<LoginResponse> => {
    throw new Error('Not implemented')
  },
  logout: async (): Promise<void> => {
    // no-op
  },
  getProfile: async (): Promise<User | null> => {
    return null
  },
  updateProfile: async (_data: Partial<User>): Promise<User> => {
    throw new Error('Not implemented')
  }
}
