// Short-lived isolate-local routing snapshot.
//
// This deliberately caches only routing metadata in Worker memory. It never
// caches an AI response, prompt, API key response, quota, or usage row. D1
// remains authoritative for authentication and billing; a CRUD mutation calls
// invalidateRoutingSnapshot so the current isolate does not wait for the TTL.
import type { Account, Group, ModelMapping } from '../types';
import type { Database } from '../db';

export interface RoutingSnapshot {
  accounts: Account[];
  groups: Group[];
  mappings: ModelMapping[];
}

interface SnapshotEntry {
  loadedAt: number;
  value: RoutingSnapshot;
}

const TTL_MS = 5000;
const snapshots = new WeakMap<object, SnapshotEntry>();
let hits = 0;
let misses = 0;

export async function loadRoutingSnapshot(db: Database, identity: object): Promise<RoutingSnapshot> {
  const now = Date.now();
  const cached = snapshots.get(identity);
  if (cached && now - cached.loadedAt < TTL_MS) {
    hits += 1;
    return cached.value;
  }

  misses += 1;
  const [accounts, groups, mappings] = await Promise.all([
    db.listEnabledAccounts(),
    db.listGroups(),
    db.listModelMappings()
  ]);
  const value = { accounts, groups, mappings } as RoutingSnapshot;
  snapshots.set(identity, { loadedAt: now, value });
  return value;
}

export function invalidateRoutingSnapshot(identity: object): void {
  snapshots.delete(identity);
}

export function routingCacheMetrics() {
  const samples = hits + misses;
  return {
    hits,
    misses,
    samples,
    hit_rate: samples ? Math.round(hits / samples * 10000) / 100 : 0,
    ttl_ms: TTL_MS
  };
}
