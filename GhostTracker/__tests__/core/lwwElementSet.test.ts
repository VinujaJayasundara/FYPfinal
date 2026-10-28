/**
 * Unit Tests: LWW-Element-Set CRDT
 * Verifies the Eq. 3.28 merge rule and the semilattice laws.
 */

import { LWWElementSet, LWWElement } from '../../src/core/crdt/lwwElementSet';

type State = Record<string, LWWElement<number>>;

function mergeStates(...states: State[]): State {
  const set = new LWWElementSet<number>();
  for (const s of states) {
    set.merge(s);
  }
  return set.getState();
}

function randomState(): State {
  const set = new LWWElementSet<number>();
  const keys = ['a', 'b', 'c', 'd'];
  const nodes = ['n1', 'n2', 'n3'];
  for (let i = 0; i < 6; i++) {
    set.set(
      keys[Math.floor(Math.random() * keys.length)],
      Math.random(),
      Math.floor(Math.random() * 5), // small range forces timestamp ties
      nodes[Math.floor(Math.random() * nodes.length)],
    );
  }
  return set.getState();
}

describe('LWWElementSet', () => {
  test('later timestamp wins', () => {
    const set = new LWWElementSet<string>();
    set.set('k', 'old', 100, 'n1');
    set.set('k', 'new', 200, 'n1');
    expect(set.get('k')).toBe('new');
  });

  test('earlier write is ignored', () => {
    const set = new LWWElementSet<string>();
    set.set('k', 'new', 200, 'n1');
    expect(set.set('k', 'old', 100, 'n2')).toBe(false);
    expect(set.get('k')).toBe('new');
  });

  test('equal timestamps resolved by larger node ID', () => {
    const set = new LWWElementSet<string>();
    set.set('k', 'from-a', 100, 'node-a');
    set.set('k', 'from-b', 100, 'node-b');
    expect(set.get('k')).toBe('from-b');

    const reversed = new LWWElementSet<string>();
    reversed.set('k', 'from-b', 100, 'node-b');
    reversed.set('k', 'from-a', 100, 'node-a');
    expect(reversed.get('k')).toBe('from-b');
  });

  test('merge reports only keys whose winner changed', () => {
    const set = new LWWElementSet<number>();
    set.set('a', 1, 10, 'n1');
    const changed = set.merge({
      a: { value: 0, timestamp: 5, nodeId: 'n2' },
      b: { value: 2, timestamp: 1, nodeId: 'n2' },
    });
    expect(changed).toEqual(['b']);
  });

  test('digest maps each key to its winning timestamp', () => {
    const set = new LWWElementSet<number>();
    set.set('a', 1, 10, 'n1');
    set.set('b', 2, 20, 'n1');
    expect(set.digest()).toEqual({ a: 10, b: 20 });
  });

  test('merge is commutative, associative and idempotent (500 random trials)', () => {
    for (let t = 0; t < 500; t++) {
      const a = randomState();
      const b = randomState();
      const c = randomState();

      expect(mergeStates(a, b)).toEqual(mergeStates(b, a));
      expect(mergeStates(mergeStates(a, b), c)).toEqual(mergeStates(a, mergeStates(b, c)));
      expect(mergeStates(a, a)).toEqual(mergeStates(a));
    }
  });
});
