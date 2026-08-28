// Failover logic with error rate and error count thresholds
import type { Env } from './index';
import type { Database } from './db';
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
  private db?: Database;
  private lastUsed = new Map<number, number>();

  constructor(env: Env) {
    const windowSeconds = Number(env.WINDOW_SECONDS);
    const errorRateThreshold = Number(env.ERROR_RATE_THRESHOLD);
    const errorCountThreshold = Number(env.ERROR_COUNT_THRESHOLD);
    this.windowMs = (Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds : 300) * 1000;
    this.errorRateThreshold = Number.isFinite(errorRateThreshold)
      ? Math.min(Math.max(errorRateThreshold, 0), 1)
      : 0.5;
    this.errorCountThreshold = Number.isFinite(errorCountThreshold) && errorCountThreshold > 0
      ? Math.floor(errorCountThreshold)
      : 5;
  }

  setDb(db: Database) {
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
    
  }

  // Get error stats for an account
  private getMemoryErrorStats(accountId: number, group?: Group): AccountErrorStats {
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
    
    const errorRateThreshold = group?.error_threshold ?? this.errorRateThreshold;
    const errorCountThreshold = group?.error_count_threshold ?? this.errorCountThreshold;
    return {
      accountId,
      channelId: window.channelId,
      groupId: window.groupId,
      windowStart: Date.now() - this.windowMs,
      totalRequests,
      errorCount,
      errorRate,
      isUnhealthy: errorRate > errorRateThreshold || errorCount >= errorCountThreshold
    };
  }

  async getErrorStats(accountId: number, group?: Group): Promise<AccountErrorStats> {
    const windowSeconds = Math.max(1, Number(group?.window_seconds) || this.windowMs / 1000);
    if (this.db) {
      try {
        const persisted = await this.db.getAccountErrorStats(accountId, windowSeconds);
        const totalRequests = Number(persisted.total_requests || 0);
        const errorCount = Number(persisted.error_count || 0);
        const errorRate = totalRequests > 0 ? errorCount / totalRequests : 0;
        return {
          accountId,
          channelId: 0,
          groupId: group?.id ?? 0,
          windowStart: Date.now() - windowSeconds * 1000,
          totalRequests,
          errorCount,
          errorRate,
          isUnhealthy: errorRate > (group?.error_threshold ?? this.errorRateThreshold)
            || errorCount >= (group?.error_count_threshold ?? this.errorCountThreshold)
        };
      } catch {
        // Fall back to the isolate-local window when D1 is temporarily unavailable.
      }
    }
    return this.getMemoryErrorStats(accountId, group);
  }

  // Select best account from available accounts
  async selectAccount(
    accounts: Account[],
    channels: Map<number, Channel>,
    groups: Map<number, Group>,
    preferredGroupId?: number
  ): Promise<SelectAccountResult | null> {
    if (accounts.length === 0) return null;
    
    const usableAccounts = accounts.filter(acc => {
      const channel = channels.get(acc.channel_id);
      const group = groups.get(acc.group_id);
      return acc.enabled === 1
        && Boolean(channel && group && channel.enabled === 1 && group.enabled === 1)
        && channel?.provider === acc.provider;
    });
    if (usableAccounts.length === 0) return null;

    // A model mapping may target a group. Prefer that group, but keep a
    // provider-compatible fallback when it has no usable accounts.
    const preferred = preferredGroupId
      ? usableAccounts.filter(acc => acc.group_id === preferredGroupId)
      : [];
    const candidateAccounts = preferred.length > 0 ? preferred : usableAccounts;

    // Filter healthy accounts
    const statsByAccount = new Map<number, AccountErrorStats>(
      await Promise.all(candidateAccounts.map(async acc => [
        acc.id,
        await this.getErrorStats(acc.id, groups.get(acc.group_id))
      ] as const))
    );
    let healthyAccounts = candidateAccounts.filter(acc => {
      const stats = statsByAccount.get(acc.id)!;
      return !stats.isUnhealthy;
    });
    
    // If all accounts are unhealthy, use the least unhealthy one
    if (healthyAccounts.length === 0) {
      healthyAccounts = [...candidateAccounts].sort((a, b) => {
        const statsA = statsByAccount.get(a.id)!;
        const statsB = statsByAccount.get(b.id)!;
        return statsA.errorRate - statsB.errorRate || statsA.errorCount - statsB.errorCount;
      });
    }
    
    // Lower priority values are preferred. Error metrics break ties, then a
    // least-recently-used tie breaker distributes traffic across equal peers.
    healthyAccounts.sort((a, b) => {
      const groupA = groups.get(a.group_id)!;
      const groupB = groups.get(b.group_id)!;
      const channelA = channels.get(a.channel_id)!;
      const channelB = channels.get(b.channel_id)!;
      const statsA = statsByAccount.get(a.id)!;
      const statsB = statsByAccount.get(b.id)!;
      return (groupA.priority - groupB.priority)
        || (channelA.priority - channelB.priority)
        || (a.priority - b.priority)
        || (statsA.errorRate - statsB.errorRate)
        || (statsA.errorCount - statsB.errorCount)
        || ((this.lastUsed.get(a.id) ?? 0) - (this.lastUsed.get(b.id) ?? 0))
        || (a.id - b.id);
    });
    
    const selected = healthyAccounts[0];
    const channel = channels.get(selected.channel_id);
    const group = groups.get(selected.group_id);
    if (!channel || !group) return null;
    this.lastUsed.set(selected.id, Date.now());
    
    return {
      account: selected,
      channel: channel!,
      group: group!,
      stats: statsByAccount.get(selected.id) ?? null
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
