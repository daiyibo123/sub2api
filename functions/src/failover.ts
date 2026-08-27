// Failover logic with error rate and error count thresholds
import { Env } from './index';
import { Account, Channel, Group, AccountErrorStats, SelectAccountResult } from './types';
import { createDatabase } from './db';

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
  private db: ReturnType<typeof createDatabase> | null = null;

  constructor(env: Env) {
    this.windowMs = parseInt(env.WINDOW_SECONDS || '300') * 1000;
    this.errorRateThreshold = parseFloat(env.ERROR_RATE_THRESHOLD || '0.5');
    this.errorCountThreshold = parseInt(env.ERROR_COUNT_THRESHOLD || '5');
  }

  setDb(db: ReturnType<typeof createDatabase>) {
    this.db = db;
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
    
    // Persist to DB
    if (this.db) {
      this.persistLog(accountId, channelId, groupId, isError).catch(() => {});
    }
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
    
    // Filter healthy accounts
    let healthyAccounts = accounts.filter(acc => {
      const stats = this.getErrorStats(acc.id);
      return !stats.isUnhealthy;
    });
    
    // If all accounts are unhealthy, use the least unhealthy one
    if (healthyAccounts.length === 0) {
      healthyAccounts = [...accounts].sort((a, b) => {
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
    // Failover on 4xx, 5xx, network errors
    return status >= 400 || status === 0;
  }

  // Persist request log to DB
  private async persistLog(accountId: number, channelId: number, groupId: number, isError: boolean) {
    if (!this.db) return;
    
    try {
      await this.db.createRequestLog({
        account_id: accountId,
        channel_id: channelId,
        group_id: groupId,
        model: '', // Will be set by caller
        status: isError ? 500 : 200,
        error_message: isError ? 'Error' : '',
        latency_ms: 0
      });
    } catch {
      // Ignore DB errors
    }
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
