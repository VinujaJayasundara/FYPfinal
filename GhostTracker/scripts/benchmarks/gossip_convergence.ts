/**
 * A4 — Simulated gossip convergence.
 *
 * Runs the real GossipSession (hash → digest → framed delta) over an
 * in-memory broadcast network. Every message reaches every other node
 * independently with probability (1 − loss). One round = every node
 * broadcasts its state hash once, then all resulting digests and frames
 * are delivered. The app runs one round every GOSSIP_INTERVAL_MS (2.5 s),
 * and the first round fires at t = 0, so convergence happens within
 * rounds × 2.5 s (reported as secondsUpperBound).
 *
 * This measures the protocol, not the radio: it ignores BLE connection
 * set-up, air time and retransmissions, so real times will be higher.
 *
 * Grid: 2/4/6/8 nodes × 0/15/30 % loss × 100 seeds; each node starts with
 * ENTRIES_PER_NODE results that no other node has.
 *
 * Output: benchmarks_output/gossip.json
 */

import { machineInfo, makeDevice, prng, summarize, writeJson } from './common';
import { GossipSession, GossipMessage, base64ToBytes } from '../../src/core/crdt/gossipSession';
import { createDigest, stateHash, hashesEqual } from '../../src/core/crdt/antiEntropy';
import { mergeWithRemote } from '../../src/core/crdt/mergeEngine';
import { GOSSIP_INTERVAL_MS } from '../../src/utils/constants';
import { LeaderboardEntry, SyncPayload } from '../../src/data/models';

const NODE_COUNTS = [2, 4, 6, 8];
const LOSS_RATES = [0, 0.15, 0.3];
const SEEDS = 100;
const ENTRIES_PER_NODE = 3;
const MAX_ROUNDS = 200;
const BASE_TIME = 1_793_000_000_000;

interface Node {
  id: string;
  crdtState: Record<string, number>;
  leaderboard: LeaderboardEntry[];
  session: GossipSession;
  errors: number;
}

function messageBytes(m: GossipMessage): number {
  // Payload bytes that would go over the radio, excluding transport headers.
  switch (m.kind) {
    case 'hash':
      return base64ToBytes(m.hash).length;
    case 'frame':
      return base64ToBytes(m.frame).length;
    case 'digest':
      return Buffer.byteLength(JSON.stringify(m.digest));
  }
}

async function simulate(nodeCount: number, loss: number, seed: number) {
  const random = prng(seed * 1000 + nodeCount * 10 + Math.round(loss * 100));
  const pending: { from: Node; message: GossipMessage }[] = [];
  const traffic = { hash: 0, digest: 0, frame: 0, bytes: 0 };

  const nodes: Node[] = Array.from({ length: nodeCount }, (_, i) => {
    const dev = makeDevice(random, `Runner ${i + 1}`, ENTRIES_PER_NODE, BASE_TIME + i * 100);
    const node = { id: dev.deviceId, crdtState: { [dev.deviceId]: ENTRIES_PER_NODE }, leaderboard: dev.leaderboard, errors: 0 } as Node;
    node.session = new GossipSession(
      {
        deviceId: node.id,
        load: async () => ({ crdtState: { ...node.crdtState }, leaderboard: [...node.leaderboard] }),
        apply: async (delta: SyncPayload) => {
          const merged = mergeWithRemote(node.crdtState, node.leaderboard, delta, node.id);
          node.crdtState = merged.mergedCRDTState;
          node.leaderboard = merged.mergedLeaderboard;
        },
      },
      message => {
        traffic[message.kind]++;
        traffic.bytes += messageBytes(message);
        pending.push({ from: node, message });
      },
      { onEvent: e => { if (e.type === 'error') node.errors++; } },
    );
    return node;
  });

  const hashOf = (n: Node) => stateHash(createDigest(n.id, n.crdtState, n.leaderboard));
  const converged = () => {
    const first = hashOf(nodes[0]);
    return nodes.every(n => hashesEqual(hashOf(n), first));
  };

  let rounds = 0;
  while (!converged() && rounds < MAX_ROUNDS) {
    for (const node of nodes) await node.session.tick();
    while (pending.length > 0) {
      const { from, message } = pending.shift()!;
      for (const node of nodes) {
        if (node !== from && random() >= loss) await node.session.receive(message);
      }
    }
    rounds++;
  }

  const complete = nodes.every(n => n.leaderboard.length === nodeCount * ENTRIES_PER_NODE);
  return {
    rounds,
    converged: converged() && complete,
    traffic,
    errors: nodes.reduce((s, n) => s + n.errors, 0),
  };
}

async function main() {
  const cells = [];
  for (const n of NODE_COUNTS) {
    for (const loss of LOSS_RATES) {
      const runs = [];
      for (let s = 1; s <= SEEDS; s++) runs.push(await simulate(n, loss, s));
      const ok = runs.filter(r => r.converged);
      const rounds = summarize(ok.map(r => r.rounds));
      const seconds = summarize(ok.map(r => (r.rounds * GOSSIP_INTERVAL_MS) / 1000));
      const bytes = summarize(ok.map(r => r.traffic.bytes));
      cells.push({
        nodes: n,
        lossPct: Math.round(loss * 100),
        runs: runs.length,
        converged: ok.length,
        rounds: { mean: rounds.mean, p50: rounds.p50, p95: rounds.p95, p99: rounds.p99, max: rounds.max },
        secondsUpperBound: { mean: seconds.mean, p50: seconds.p50, p95: seconds.p95, p99: seconds.p99, max: seconds.max },
        totalBytesUntilConverged: { mean: bytes.mean, p99: bytes.p99 },
        meanMessages: {
          hash: ok.reduce((s, r) => s + r.traffic.hash, 0) / ok.length,
          digest: ok.reduce((s, r) => s + r.traffic.digest, 0) / ok.length,
          frame: ok.reduce((s, r) => s + r.traffic.frame, 0) / ok.length,
        },
        errors: runs.reduce((s, r) => s + r.errors, 0),
      });
      const c = cells[cells.length - 1];
      console.log(
        `  ${n} nodes, ${String(c.lossPct).padStart(2)}% loss: ${c.converged}/${c.runs} converged, ` +
          `rounds mean ${c.rounds.mean.toFixed(2)} p99 ${c.rounds.p99}, ` +
          `time mean ${c.secondsUpperBound.mean.toFixed(2)} s p99 ${c.secondsUpperBound.p99.toFixed(1)} s`,
      );
    }
  }

  const result = {
    benchmark: 'A4 simulated anti-entropy gossip convergence (real GossipSession, in-memory network)',
    caveat: 'Protocol simulation. Excludes BLE connection set-up, air time and retransmission; on-device times will be higher.',
    machine: machineInfo(),
    config: {
      nodeCounts: NODE_COUNTS,
      lossRates: LOSS_RATES,
      seedsPerCell: SEEDS,
      entriesPerNode: ENTRIES_PER_NODE,
      roundIntervalMs: GOSSIP_INTERVAL_MS,
      maxRounds: MAX_ROUNDS,
      lossModel: 'independent per message per receiver',
    },
    steadyStateBytesPerRound: 'nodes × 16 (one state hash each)',
    cells,
  };
  const file = writeJson('gossip.json', result);
  console.log(`  -> ${file}`);
}

console.log('A4 gossip convergence (simulated)');
main().catch(e => {
  console.error(e);
  process.exit(1);
});
