/**
 * CRDT Merge Engine
 *
 * Orchestrates the merging of CRDT state and leaderboard data
 * from a remote peer into the local database.
 *
 * This is the core consensus mechanism:
 * 1. Merge G-Counter states (element-wise MAX)
 * 2. Merge leaderboard entries (LWW-Element-Set per device+route)
 * 3. Produce a unified, identical-across-all-peers result
 */

import { GCounter } from './gCounter';
import { LWWElement, LWWElementSet } from './lwwElementSet';
import { SyncPayload, LeaderboardEntry } from '../../data/models';
import { Logger } from '../../utils/logger';

const log = Logger.create('MergeEngine');

/**
 * Result of a merge operation.
 */
export interface MergeResult {
  /** The merged CRDT state vector */
  mergedCRDTState: Record<string, number>;
  /** The merged leaderboard entries */
  mergedLeaderboard: LeaderboardEntry[];
  /** Number of new entries added */
  newEntriesCount: number;
  /** Number of entries updated */
  updatedEntriesCount: number;
  /** Whether any changes were made */
  hasChanges: boolean;
}

/**
 * The LWW key for a leaderboard entry: one slot per (device, route).
 */
export function leaderboardKey(entry: LeaderboardEntry): string {
  return `${entry.deviceId}:${entry.routeId}`;
}

/**
 * Wrap a leaderboard entry as an LWW element. The writer of an entry is
 * its owning device; the entry ID breaks ties between two writes from it.
 * syncedAt is receiver-local metadata, so it is left out of the replicated value.
 */
export function toLWWElement(entry: LeaderboardEntry): LWWElement<LeaderboardEntry> {
  return {
    value: { ...entry, syncedAt: null },
    timestamp: entry.updatedAt,
    nodeId: `${entry.deviceId}/${entry.id}`,
  };
}

/**
 * Build an LWW-Element-Set from a list of leaderboard entries.
 */
export function buildLeaderboardSet(entries: LeaderboardEntry[]): LWWElementSet<LeaderboardEntry> {
  const set = new LWWElementSet<LeaderboardEntry>();
  for (const entry of entries) {
    set.merge({ [leaderboardKey(entry)]: toLWWElement(entry) });
  }
  return set;
}

/**
 * Merge a remote sync payload with local state.
 *
 * This function is the heart of the P2P consensus protocol.
 * It guarantees:
 *   - Commutativity: merge(local, remote) = merge(remote, local)
 *   - Idempotency: merging the same payload twice has no effect
 *   - Determinism: same inputs always produce the same output
 *
 * @param localCRDTState - Local G-Counter state
 * @param localLeaderboard - Local leaderboard entries
 * @param remotePayload - Received sync payload from peer
 * @param localDeviceId - This device's unique ID
 * @returns MergeResult with unified state
 */
export function mergeWithRemote(
  localCRDTState: Record<string, number>,
  localLeaderboard: LeaderboardEntry[],
  remotePayload: SyncPayload,
  localDeviceId: string,
): MergeResult {
  log.info(`Starting merge with device ${remotePayload.deviceId}`);

  // ── Step 1: Merge G-Counter States ──────────────────────────
  const localCounter = new GCounter(localDeviceId, localCRDTState);
  localCounter.merge(remotePayload.crdtState);
  const mergedCRDTState = localCounter.getState();

  // ── Step 2: Merge Leaderboard Entries ───────────────────────
  const {
    mergedLeaderboard,
    newEntriesCount,
    updatedEntriesCount,
  } = mergeLeaderboardEntries(localLeaderboard, remotePayload.leaderboardEntries);

  // A G-Counter-only change (the peer has seen more runs in some slot) is a
  // change too: if it were not persisted, the state hashes would never match
  // and gossip would re-send the same digest every round.
  const counterChanged = Object.entries(mergedCRDTState).some(
    ([replicaId, count]) => (localCRDTState[replicaId] ?? 0) !== count,
  );
  const hasChanges = newEntriesCount > 0 || updatedEntriesCount > 0 || counterChanged;

  log.info(
    `Merge complete. New: ${newEntriesCount}, Updated: ${updatedEntriesCount}, ` +
      `Total entries: ${mergedLeaderboard.length}, CRDT value: ${localCounter.value()}`,
  );

  return {
    mergedCRDTState,
    mergedLeaderboard,
    newEntriesCount,
    updatedEntriesCount,
    hasChanges,
  };
}

/**
 * Merge leaderboard entries from two sources using the LWW-Element-Set.
 *
 * Per (deviceId, routeId) slot, the entry with the latest updatedAt wins;
 * equal timestamps are broken by writer ID (Eq. 3.28). A device only
 * rewrites its own entry when its score improves, so the latest write is
 * also its best score.
 */
function mergeLeaderboardEntries(
  localEntries: LeaderboardEntry[],
  remoteEntries: LeaderboardEntry[],
): {
  mergedLeaderboard: LeaderboardEntry[];
  newEntriesCount: number;
  updatedEntriesCount: number;
} {
  const set = buildLeaderboardSet(localEntries);
  const localKeys = new Set(set.keys());
  const localSyncedAt = new Map(localEntries.map(e => [e.id, e.syncedAt]));

  const changedKeys = new Set<string>();
  for (const entry of remoteEntries) {
    for (const key of set.merge({ [leaderboardKey(entry)]: toLWWElement(entry) })) {
      changedKeys.add(key);
    }
  }

  let newEntriesCount = 0;
  let updatedEntriesCount = 0;
  for (const key of changedKeys) {
    if (localKeys.has(key)) {
      updatedEntriesCount++;
    } else {
      newEntriesCount++;
    }
  }

  // Reattach local syncedAt: entries just received from the peer get "now"
  const now = Date.now();
  const mergedLeaderboard = set.keys().map(key => {
    const entry = set.get(key)!;
    return {
      ...entry,
      syncedAt: changedKeys.has(key) ? now : localSyncedAt.get(entry.id) ?? null,
    };
  });

  return {
    mergedLeaderboard,
    newEntriesCount,
    updatedEntriesCount,
  };
}

/**
 * Verify that two merged states are identical (convergence test).
 *
 * @param stateA - CRDT state from device A after merge
 * @param stateB - CRDT state from device B after merge
 * @returns True if states have converged to identical values
 */
export function verifyConvergence(
  stateA: Record<string, number>,
  stateB: Record<string, number>,
): boolean {
  const keysA = Object.keys(stateA).sort();
  const keysB = Object.keys(stateB).sort();

  if (keysA.length !== keysB.length) {
    return false;
  }

  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) {
      return false;
    }
    if (stateA[keysA[i]] !== stateB[keysB[i]]) {
      return false;
    }
  }

  return true;
}
