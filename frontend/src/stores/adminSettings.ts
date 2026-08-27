/**
 * Admin Settings Store (精简版 stub)
 * 保留空实现以避免编译错误
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useAdminSettingsStore = defineStore('adminSettings', () => {
  const customMenuItems = ref<any[]>([])

  const fetch = async () => {
    // No-op in simplified mode
  }

  return {
    customMenuItems,
    fetch
  }
})
