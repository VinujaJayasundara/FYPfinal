/**
 * Anti-Entropy Gossip Protocol
 *
 * Keeps connected peers converged without resending the whole state on
 * every round. Each round (every GOSSIP_INTERVAL_MS):
 *
 *   1. Hash exchange — each peer sends a 16-byte hash of its state.
 *      Equal hashes mean the replicas are already identical: stop.
 *   2. Digest exchange — each peer sends its digest:
 *      G-Counter state + { leaderboard key → updatedAt }.
 *   3. Delta transmission — each peer sends only the leaderboard entries
 *      the other is missing or holds an older version of. The receiver
 *      applies them with the normal CRDT merge (mergeWithRemote).
 *
 * The G-Counter map is tiny (one number per device), so it is sent in full
 * with the digest rather than diffed.
 */

import { LeaderboardEntry, SyncPayload } from '../../data/models';
import { STATE_HASH_BYTES } from '../../utils/constants';
import { leaderboardKey } from './mergeEngine';

export interface SyncDigest {
  deviceId: string;
  crdtState: Record<string, number>;
  /** Leaderboard key → updatedAt of the version this peer holds */
  entries: Record<string, number>;
}

/**
 * Build this peer's digest from its local state.
 */
export function createDigest(
  deviceId: string,
  crdtState: Record<string, number>,
  leaderboard: LeaderboardEntry[],
): SyncDigest {
  const entries: Record<string, number> = {};
  for (const entry of leaderboard) {
    const key = leaderboardKey(entry);
    entries[key] = Math.max(entries[key] ?? -Infinity, entry.updatedAt);
  }
  return { deviceId, crdtState: { ...crdtState }, entries };
}

/**
 * Compute the delta to send to a peer, given the peer's digest.
 * Includes every local entry the peer lacks or holds an older version of.
 */
export function computeDelta(
  localDeviceId: string,
  localCRDTState: Record<string, number>,
  localLeaderboard: LeaderboardEntry[],
  remoteDigest: SyncDigest,
): SyncPayload {
  const leaderboardEntries = localLeaderboard.filter(entry => {
    const remoteUpdatedAt = remoteDigest.entries[leaderboardKey(entry)];
    return remoteUpdatedAt === undefined || entry.updatedAt > remoteUpdatedAt;
  });

  return {
    deviceId: localDeviceId,
    timestamp: Date.now(),
    crdtState: { ...localCRDTState },
    leaderboardEntries,
    version: 1,
  };
}

/**
 * True when the remote digest proves the peer is missing nothing we have.
 */
export function peerIsUpToDate(
  localCRDTState: Record<string, number>,
  localLeaderboard: LeaderboardEntry[],
  remoteDigest: SyncDigest,
): boolean {
  for (const [replicaId, count] of Object.entries(localCRDTState)) {
    if ((remoteDigest.crdtState[replicaId] ?? 0) < count) {
      return false;
    }
  }
  return localLeaderboard.every(entry => {
    const remoteUpdatedAt = remoteDigest.entries[leaderboardKey(entry)];
    return remoteUpdatedAt !== undefined && remoteUpdatedAt >= entry.updatedAt;
  });
}

/**
 * 16-byte hash of a replica's state, independent of entry order.
 * Built from four FNV-1a 32-bit hashes with different seeds over a
 * canonical (sorted) string form of the G-Counter and the digest.
 * Used only to detect "already identical"; it is not a security hash.
 */
export function stateHash(digest: SyncDigest): Uint8Array {
  const counter = Object.keys(digest.crdtState)
    .sort()
    .map(k => `${k}=${digest.crdtState[k]}`)
    .join(',');
  const entries = Object.keys(digest.entries)
    .sort()
    .map(k => `${k}@${digest.entries[k]}`)
    .join(',');
  const canonical = `${counter}|${entries}`;

  const seeds = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  const out = new Uint8Array(STATE_HASH_BYTES);
  const view = new DataView(out.buffer);
  seeds.forEach((seed, i) => {
    let h = seed >>> 0;
    for (let c = 0; c < canonical.length; c++) {
      h ^= canonical.charCodeAt(c);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    view.setUint32(i * 4, h, true);
  });
  return out;
}

/**
 * Compare two state hashes.
 */
export function hashesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
