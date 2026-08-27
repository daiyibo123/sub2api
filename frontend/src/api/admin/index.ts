// Admin API stubs for simplified deployment
export const adminAPI = {
  accounts: {
    list: async () => ({ items: [] }),
    listWithEtag: async () => ({ items: [] }),
    getBatchTodayStats: async () => ({}),
    getUpstreamBillingProbeSettings: async () => ({ enabled: true, interval_minutes: 30 }),
    delete: async () => {},
    batchClearError: async () => {},
    batchRefresh: async () => {},
    toggleSchedulable: async () => {}
  },
  proxies: {
    getAll: async () => []
  },
  groups: {
    getAll: async () => []
  },
  channels: {
    getAll: async () => []
  },
  usage: {
    list: async () => []
  },
  ops: {
    getStats: async () => ({}),
    getMetrics: async () => ({})
  }
}
