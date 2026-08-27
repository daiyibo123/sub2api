/**
 * Onboarding Store (精简版 stub)
 * 保留空实现以避免编译错误
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useOnboardingStore = defineStore('onboarding', () => {
  const currentStep = ref<string | null>(null)

  const setReplayCallback = (_callback: any) => {
    // No-op
  }

  const replay = () => {
    // No-op
  }

  const isCurrentStep = (_selector: string) => false
  const nextStep = (_delay?: number) => {
    // No-op
  }
  const getDriverInstance = () => null
  const setDriverInstance = (_instance: any) => {
    // No-op
  }
  const isDriverActive = () => false
  const setControlMethods = (_methods: any) => {
    // No-op
  }

  return {
    currentStep,
    setReplayCallback,
    replay,
    isCurrentStep,
    nextStep,
    getDriverInstance,
    setDriverInstance,
    isDriverActive,
    setControlMethods
  }
})
