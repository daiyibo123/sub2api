// Failover logic with error rate and error count thresholds
import type { Env } from './index';
import type { Database } from './db';
import { Account, Group, AccountErrorStats, SelectAccountResult } from './types';
import { accountRateMultiplier } from './utils/proxy';

interface ErrorWindow {
  accountId: number;
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
  recordRequest(accountId: number, groupId: number, isError: boolean): void {
    const now = Date.now();
    const key = accountId;
    
    let window = this.errorWindows.get(key);
    if (!window) {
      window = {
        accountId,
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
    groups: Map<number, Group>,
    preferredGroupId?: number,
    fallbackGroupIds: number[] = []
  ): Promise<SelectAccountResult | null> {
    if (accounts.length === 0) return null;

    const usableAccounts = accounts.filter(acc => {
      const group = groups.get(acc.group_id);
      return acc.enabled === 1 && Boolean(group && group.enabled === 1);
    });
    if (usableAccounts.length === 0) return null;

    // A pinned primary group is a hard first tier. A fallback group is only
    // considered after the primary tier has no candidate left; this prevents a
    // slower/cheaper account in another group from stealing primary traffic.
    const primary = preferredGroupId
      ? usableAccounts.filter(acc => acc.group_id === preferredGroupId)
      : [];
    const hasFallbackPolicy = Boolean(preferredGroupId && fallbackGroupIds.length);
    const initialAccounts = primary.length > 0
      ? primary
      : hasFallbackPolicy
        ? usableAccounts.filter(acc => fallbackGroupIds.includes(acc.group_id))
        : usableAccounts;
    if (initialAccounts.length === 0) return null;

    const statsByAccount = new Map<number, AccountErrorStats>(
      await Promise.all(initialAccounts.map(async acc => [
        acc.id,
        await this.getErrorStats(acc.id, groups.get(acc.group_id))
      ] as const))
    );
    let healthyAccounts = initialAccounts.filter(acc => !statsByAccount.get(acc.id)!.isUnhealthy);

    // With a primary/fallback policy, an unhealthy primary tier must not be
    // selected merely because it is the least unhealthy. Move to the fallback
    // tier instead. If the fallback tier is also unhealthy, use its least-bad
    // account as the final admission fallback rather than failing outright.
    if (healthyAccounts.length === 0 && hasFallbackPolicy && primary.length > 0) {
      const fallback = usableAccounts.filter(acc => fallbackGroupIds.includes(acc.group_id));
      if (fallback.length === 0) return null;
      const fallbackStats = await Promise.all(fallback.map(async acc => [
        acc.id,
        await this.getErrorStats(acc.id, groups.get(acc.group_id))
      ] as const));
      for (const [id, stats] of fallbackStats) statsByAccount.set(id, stats);
      healthyAccounts = fallback.filter(acc => !statsByAccount.get(acc.id)!.isUnhealthy);
      if (healthyAccounts.length === 0) healthyAccounts = fallback;
    }

    // Every account is circuit-broken: fall back to the least unhealthy rather
    // than refusing the request outright. This applies only when there is no
    // explicit fallback tier, or after the fallback tier has been selected.
    if (healthyAccounts.length === 0) {
      healthyAccounts = [...initialAccounts].sort((a, b) => {
        const statsA = statsByAccount.get(a.id)!;
        const statsB = statsByAccount.get(b.id)!;
        return statsA.errorRate - statsB.errorRate || statsA.errorCount - statsB.errorCount;
      });
    }

    healthyAccounts.sort((a, b) => {
      const groupA = groups.get(a.group_id)!;
      const groupB = groups.get(b.group_id)!;
      const statsA = statsByAccount.get(a.id)!;
      const statsB = statsByAccount.get(b.id)!;
      // Explicit ordering stays dominant so operators keep hard control: group
      // priority first, then account priority. Billing weight only breaks ties
      // between equally-prioritised accounts, where preferring the cheaper
      // upstream costs nothing.
      return (groupA.priority - groupB.priority)
        || (a.priority - b.priority)
        || (accountRateMultiplier(a) - accountRateMultiplier(b))
        || (statsA.errorRate - statsB.errorRate)
        || (statsA.errorCount - statsB.errorCount)
        || ((this.lastUsed.get(a.id) ?? 0) - (this.lastUsed.get(b.id) ?? 0))
        || (a.id - b.id);
    });

    const selected = healthyAccounts[0];
    const group = groups.get(selected.group_id);
    if (!group) return null;
    this.lastUsed.set(selected.id, Date.now());

    return {
      account: selected,
      group,
      stats: statsByAccount.get(selected.id) ?? null
    };
  }

  /** Persist a health probe result so the console can show liveness. */
  async recordHealthCheck(accountId: number, ok: boolean, latencyMs: number, message: string): Promise<void> {
    if (!this.db) return;
    await this.db.recordAccountHealthCheck(accountId, ok, latencyMs, message).catch(() => {});
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

