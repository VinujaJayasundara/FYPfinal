/**
 * Ghost-Tracker — P2P Sync Adapter
 *
 * The CRDT logic (G-Counter, LWW-Element-Set, merge, anti-entropy, binary
 * framing) lives in the shared core engine: GhostTracker/src/core/crdt.
 * This module adapts it to the app's SQLite row format and adds the
 * app-level social-consensus "witness" records.
 */

import { GCounter, mergeWithRemote } from '../../../GhostTracker/src/core/crdt';
import type {
  LeaderboardEntry,
  SyncPayload as CoreSyncPayload,
} from '../../../GhostTracker/src/data/models';
import { DBLeaderboardEntry } from '../data/database';

export { GCounter };

/** Sync payload in the app's database row format. */
export interface SyncPayload {
  deviceId: string;
  timestamp: number;
  crdtState: Record<string, number>;
  leaderboardEntries: DBLeaderboardEntry[];
  version: number;
}

export interface MergeResult {
  mergedCRDTState: Record<string, number>;
  mergedLeaderboard: DBLeaderboardEntry[];
  witnessUpdates: { entryId: string; witnessId: string }[];
  newEntriesCount: number;
  updatedEntriesCount: number;
  hasChanges: boolean;
}

// ── Row ↔ core model conversion ───────────────────────────

export function toCoreEntry(e: DBLeaderboardEntry): LeaderboardEntry {
  return {
    id: e.id,
    deviceId: e.device_id,
    userAlias: e.user_alias,
    routeId: e.route_id,
    riiScore: e.rii_score,
    npiScore: e.npi_score,
    totalTimeS: e.total_time_s,
    syncedAt: e.synced_at,
    createdAt: e.created_at,
    updatedAt: e.updated_at ?? e.created_at,
  };
}

export function toDBEntry(e: LeaderboardEntry): DBLeaderboardEntry {
  return {
    id: e.id,
    device_id: e.deviceId,
    user_alias: e.userAlias,
    route_id: e.routeId,
    rii_score: e.riiScore,
    npi_score: e.npiScore,
    total_time_s: e.totalTimeS,
    synced_at: e.syncedAt,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
  };
}

export function toCorePayload(p: SyncPayload): CoreSyncPayload {
  return { ...p, leaderboardEntries: p.leaderboardEntries.map(toCoreEntry) };
}

export function toDBPayload(p: CoreSyncPayload): SyncPayload {
  return { ...p, leaderboardEntries: p.leaderboardEntries.map(toDBEntry) };
}

/**
 * Merge a peer's payload into local state using the core CRDT engine.
 *
 * 1. G-Counters merge by element-wise MAX.
 * 2. Leaderboard entries merge as an LWW-Element-Set per (device_id, route_id):
 *    the latest updated_at wins, equal timestamps break on writer ID.
 * 3. The sending peer is recorded as a witness for every entry it sent
 *    that matches the version we now hold (it vouches for that version).
 */
export function mergeSyncPayloads(
  localDeviceId: string,
  localCRDTState: Record<string, number>,
  localLeaderboard: DBLeaderboardEntry[],
  remotePayload: SyncPayload,
): MergeResult {
  const result = mergeWithRemote(
    localCRDTState,
    localLeaderboard.map(toCoreEntry),
    toCorePayload(remotePayload),
    localDeviceId,
  );

  const held = new Map(result.mergedLeaderboard.map(e => [e.id, e]));
  const witnessUpdates = remotePayload.leaderboardEntries
    .filter(e => {
      const current = held.get(e.id);
      return current !== undefined && current.updatedAt === (e.updated_at ?? e.created_at);
    })
    .map(e => ({ entryId: e.id, witnessId: remotePayload.deviceId }));

  return {
    mergedCRDTState: result.mergedCRDTState,
    mergedLeaderboard: result.mergedLeaderboard.map(toDBEntry),
    witnessUpdates,
    newEntriesCount: result.newEntriesCount,
    updatedEntriesCount: result.updatedEntriesCount,
    hasChanges: result.hasChanges || witnessUpdates.length > 0,
  };
}
