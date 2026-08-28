// Failover logic with error rate and error count thresholds
import type { Env } from './index';
import { Account, Channel, Group, AccountErrorStats, SelectAccountResult } from './types';

interface ErrorWindow {
  accountId: number;
  channelId: number;
  groupId: number;
  timestamps: number[];
  errors: number[];
}

export class FailoverManager {
  private errorWindows: Map<number, ErrorWindow> = new Map();
  private windowMs: number;
  private errorRateThreshold: number;
  private errorCountThreshold: number;

  constructor(env: Env) {
    this.windowMs = parseInt(env.WINDOW_SECONDS || '300') * 1000;
    this.errorRateThreshold = parseFloat(env.ERROR_RATE_THRESHOLD || '0.5');
    this.errorCountThreshold = parseInt(env.ERROR_COUNT_THRESHOLD || '5');
  }

  setDb(_db: unknown) {
    // Request logs are written by the route handlers.
  }

  // Record request result for error tracking
  recordRequest(accountId: number, channelId: number, groupId: number, isError: boolean): void {
    const now = Date.now();
    const key = accountId;
    
    let window = this.errorWindows.get(key);
    if (!window) {
      window = {
        accountId,
        channelId,
        groupId,
        timestamps: [],
        errors: []
      };
      this.errorWindows.set(key, window);
    }
    
    // Clean old entries
    const cutoff = now - this.windowMs;
    while (window.timestamps.length > 0 && window.timestamps[0] < cutoff) {
      window.timestamps.shift();
      window.errors.shift();
    }
    
    // Add new entry
    window.timestamps.push(now);
    window.errors.push(isError ? 1 : 0);
    
  }

  // Get error stats for an account
  getErrorStats(accountId: number): AccountErrorStats {
    const window = this.errorWindows.get(accountId);
    if (!window) {
      return {
        accountId,
        channelId: 0,
        groupId: 0,
        windowStart: Date.now() - this.windowMs,
        totalRequests: 0,
        errorCount: 0,
        errorRate: 0,
        isUnhealthy: false
      };
    }
    
    const totalRequests = window.timestamps.length;
    const errorCount = window.errors.reduce((sum, err) => sum + err, 0);
    const errorRate = totalRequests > 0 ? errorCount / totalRequests : 0;
    
    return {
      accountId,
      channelId: window.channelId,
      groupId: window.groupId,
      windowStart: Date.now() - this.windowMs,
      totalRequests,
      errorCount,
      errorRate,
      isUnhealthy: errorRate > this.errorRateThreshold || errorCount >= this.errorCountThreshold
    };
  }

  // Select best account from available accounts
  selectAccount(accounts: Account[], channels: Map<number, Channel>, groups: Map<number, Group>): SelectAccountResult | null {
    if (accounts.length === 0) return null;
    
    const usableAccounts = accounts.filter(acc => {
      const channel = channels.get(acc.channel_id);
      const group = groups.get(acc.group_id);
      return acc.enabled === 1
        && Boolean(channel && group && channel.enabled === 1 && group.enabled === 1);
    });
    if (usableAccounts.length === 0) return null;

    // Filter healthy accounts
    let healthyAccounts = usableAccounts.filter(acc => {
      const stats = this.getErrorStats(acc.id);
      return !stats.isUnhealthy;
    });
    
    // If all accounts are unhealthy, use the least unhealthy one
    if (healthyAccounts.length === 0) {
      healthyAccounts = [...usableAccounts].sort((a, b) => {
        const statsA = this.getErrorStats(a.id);
        const statsB = this.getErrorStats(b.id);
        return statsA.errorRate - statsB.errorRate || statsA.errorCount - statsB.errorCount;
      });
    }
    
    // Sort by priority
    healthyAccounts.sort((a, b) => a.priority - b.priority);
    
    const selected = healthyAccounts[0];
    const channel = channels.get(selected.channel_id);
    const group = groups.get(selected.group_id);
    if (!channel || !group) return null;
    
    return {
      account: selected,
      channel: channel!,
      group: group!,
      stats: this.getErrorStats(selected.id)
    };
  }

  // Check if error should trigger failover
  shouldFailover(error: any): boolean {
    if (!error) return false;
    
    const status = error.status || error.statusCode || 0;
    // Retry transient upstream failures, but preserve useful client errors.
    return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
  }

  // Cleanup old windows periodically
  cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs * 2; // Keep 2x window for safety
    
    for (const [key, window] of this.errorWindows) {
      if (window.timestamps.length > 0 && window.timestamps[window.timestamps.length - 1] < cutoff) {
        this.errorWindows.delete(key);
      }
    }
  }
}
