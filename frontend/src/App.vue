<script setup lang="ts">
import { RouterView, useRoute } from 'vue-router'
import { watch, onMounted } from 'vue'
import Toast from '@/components/common/Toast.vue'
import NavigationProgress from '@/components/common/NavigationProgress.vue'
import { resolveRouteDocumentTitle } from '@/router/title'
import { useAppStore, useAuthStore } from '@/stores'
import { updateFavicon } from '@/utils/branding'

const route = useRoute()
const appStore = useAppStore()
const authStore = useAuthStore()

function updateDocumentTitle() {
  const customMenuItems = appStore.cachedPublicSettings?.custom_menu_items ?? []
  document.title = resolveRouteDocumentTitle(route, appStore.siteName, customMenuItems)
}

// Watch for site settings changes and update favicon/title
watch(
  () => appStore.siteLogo,
  (newLogo) => {
    if (newLogo) {
      updateFavicon(newLogo)
    }
  },
  { immediate: true }
)

watch(
  [
    () => route.fullPath,
    () => route.meta.title,
    () => route.meta.titleKey,
    () => appStore.siteName,
    () => appStore.cachedPublicSettings?.custom_menu_items,
  ],
  updateDocumentTitle,
  { deep: true }
)

// Route change trigger
watch(
  () => route.fullPath,
  () => {
    if (authStore.isAuthenticated) {
      // Simplified: no announcements/subscriptions polling
    }
  }
)

onMounted(async () => {
  // Load public settings
  try {
    await appStore.fetchPublicSettings()
  } catch (error) {
    console.warn('Failed to load public settings:', error)
  }
})
</script>

<template>
  <div id="app">
    <NavigationProgress />
    <Toast />
    <RouterView />
  </div>
</template>

<style>
#app {
  min-height: 100vh;
}
</style>
