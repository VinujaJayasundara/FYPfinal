/**
 * LWW-Element-Set (Last-Writer-Wins Element Set) — State-Based CRDT
 *
 * Stores one value per key (e.g. one leaderboard entry per device+route).
 * Each element carries the timestamp of its last write and the ID of the
 * node that wrote it.
 *
 * Merge rule for two versions of the same key (Eq. 3.28):
 *   - The version with the later timestamp wins
 *   - Equal timestamps: the version with the lexicographically larger
 *     node ID wins, so every replica picks the same winner
 *   - Equal timestamp and node ID (one node writing twice in the same
 *     millisecond): the larger serialized value wins, so the order stays total
 *
 * Because "pick the winner" is a total order on (timestamp, nodeId),
 * merge is commutative, associative and idempotent.
 *
 * Reference: Shapiro et al., "Conflict-free Replicated Data Types" (2011)
 */

export interface LWWElement<T> {
  value: T;
  timestamp: number;
  nodeId: string;
}

/**
 * Compare two writes. Returns true if `a` should replace `b`.
 */
export function lwwWins<T>(a: LWWElement<T>, b: LWWElement<T>): boolean {
  if (a.timestamp !== b.timestamp) {
    return a.timestamp > b.timestamp;
  }
  if (a.nodeId !== b.nodeId) {
    return a.nodeId > b.nodeId;
  }
  return JSON.stringify(a.value) > JSON.stringify(b.value);
}

export class LWWElementSet<T> {
  private elements: Map<string, LWWElement<T>>;

  constructor(initial?: Record<string, LWWElement<T>>) {
    this.elements = new Map(initial ? Object.entries(initial) : []);
  }

  /**
   * Write a value locally. Ignored if an existing write already wins.
   *
   * @returns True if the write was applied
   */
  set(key: string, value: T, timestamp: number, nodeId: string): boolean {
    return this.apply(key, { value, timestamp, nodeId });
  }

  get(key: string): T | undefined {
    return this.elements.get(key)?.value;
  }

  getElement(key: string): LWWElement<T> | undefined {
    return this.elements.get(key);
  }

  keys(): string[] {
    return Array.from(this.elements.keys());
  }

  values(): T[] {
    return Array.from(this.elements.values()).map(e => e.value);
  }

  size(): number {
    return this.elements.size;
  }

  /**
   * Merge another replica's state into this one.
   *
   * @returns Keys whose winning value changed locally
   */
  merge(remote: Record<string, LWWElement<T>>): string[] {
    const changed: string[] = [];
    for (const [key, element] of Object.entries(remote)) {
      if (this.apply(key, element)) {
        changed.push(key);
      }
    }
    return changed;
  }

  /**
   * Compact summary of this replica: key → timestamp of its current winner.
   * Peers compare digests to find which keys they are missing or have stale.
   */
  digest(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, element] of this.elements) {
      out[key] = element.timestamp;
    }
    return out;
  }

  getState(): Record<string, LWWElement<T>> {
    return Object.fromEntries(this.elements);
  }

  private apply(key: string, incoming: LWWElement<T>): boolean {
    const existing = this.elements.get(key);
    if (existing && !lwwWins(incoming, existing)) {
      return false;
    }
    this.elements.set(key, { ...incoming });
    return true;
  }
}
