/**
 * Anti-Entropy Gossip Session
 *
 * Runs the anti-entropy protocol from antiEntropy.ts over any transport
 * that can broadcast small messages (Wi-Fi relay today, BLE GATT later).
 * Every GOSSIP_INTERVAL_MS this peer broadcasts its 16-byte state hash.
 *
 *   hash   — broadcast. A peer whose hash differs replies with its digest.
 *   digest — addressed. The receiver computes the delta the sender is
 *            missing and sends it back as binary frames.
 *   frame  — addressed. One ≤ maxFrameBytes chunk of a binary delta
 *            (encodeBinaryPayload + splitIntoFrames). Frames are
 *            reassembled per sender and applied with the CRDT merge.
 *
 * Both peers broadcast hashes, so a mismatch makes each side send its
 * digest and each side receives exactly the entries it lacks.
 * Incoming messages are processed one at a time so local state is never
 * merged concurrently.
 */

import { LeaderboardEntry, SyncPayload } from '../../data/models';
import { BLE_MAX_PAYLOAD_BYTES, GOSSIP_INTERVAL_MS } from '../../utils/constants';
import { SyncDigest, computeDelta, createDigest, hashesEqual, peerIsUpToDate, stateHash } from './antiEntropy';
import { FrameAssembler, decodeBinaryPayload, encodeBinaryPayload, splitIntoFrames } from './stateVector';

export type GossipMessage =
  | { kind: 'hash'; from: string; hash: string }
  | { kind: 'digest'; from: string; to: string; digest: SyncDigest }
  | { kind: 'frame'; from: string; to: string; frame: string };

export interface GossipStore {
  deviceId: string;
  /** Read the current local replica. */
  load(): Promise<{ crdtState: Record<string, number>; leaderboard: LeaderboardEntry[] }>;
  /** Merge a received delta into the local replica. */
  apply(delta: SyncPayload): Promise<void>;
}

export type GossipEvent =
  | { type: 'mismatch'; peer: string }
  | { type: 'in-sync'; peer: string }
  | { type: 'delta-sent'; peer: string; entries: number; bytes: number; frames: number }
  | { type: 'delta-applied'; peer: string; entries: number }
  | { type: 'error'; error: string };

export interface GossipOptions {
  intervalMs?: number;
  maxFrameBytes?: number;
  onEvent?: (event: GossipEvent) => void;
}

export class GossipSession {
  private readonly intervalMs: number;
  private readonly maxFrameBytes: number;
  private readonly onEvent: (event: GossipEvent) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private assemblers = new Map<string, FrameAssembler>();
  private inSync = new Map<string, boolean>();
  private nextMessageId = 0;

  constructor(
    private readonly store: GossipStore,
    private readonly send: (message: GossipMessage) => void,
    options: GossipOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? GOSSIP_INTERVAL_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? BLE_MAX_PAYLOAD_BYTES;
    this.onEvent = options.onEvent ?? (() => {});
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.assemblers.clear();
    this.inSync.clear();
  }

  /** Forget a peer that left (drops its partial frames). */
  forgetPeer(peerId: string): void {
    this.assemblers.delete(peerId);
    this.inSync.delete(peerId);
  }

  /** One gossip round: broadcast the local state hash. */
  tick(): Promise<void> {
    return this.enqueue(async () => {
      const digest = await this.localDigest();
      this.send({ kind: 'hash', from: this.store.deviceId, hash: bytesToBase64(stateHash(digest)) });
    });
  }

  /** Handle a message from the transport. Messages for other peers are ignored. */
  receive(message: GossipMessage): Promise<void> {
    if (message.from === this.store.deviceId) {
      return Promise.resolve();
    }
    if (message.kind !== 'hash' && message.to !== this.store.deviceId) {
      return Promise.resolve();
    }
    return this.enqueue(() => this.handle(message));
  }

  // ── Internal ────────────────────────────────────────────

  private async handle(message: GossipMessage): Promise<void> {
    switch (message.kind) {
      case 'hash': {
        const digest = await this.localDigest();
        const same = hashesEqual(stateHash(digest), base64ToBytes(message.hash));
        if (same !== this.inSync.get(message.from)) {
          this.inSync.set(message.from, same);
          this.onEvent({ type: same ? 'in-sync' : 'mismatch', peer: message.from });
        }
        if (!same) {
          this.send({ kind: 'digest', from: this.store.deviceId, to: message.from, digest });
        }
        return;
      }

      case 'digest': {
        const { crdtState, leaderboard } = await this.store.load();
        if (peerIsUpToDate(crdtState, leaderboard, message.digest)) {
          return;
        }
        const delta = computeDelta(this.store.deviceId, crdtState, leaderboard, message.digest);
        const bytes = encodeBinaryPayload(delta);
        const frames = splitIntoFrames(bytes, this.nextMessageId, this.maxFrameBytes);
        this.nextMessageId = (this.nextMessageId + 1) & 0xffff;
        for (const frame of frames) {
          this.send({ kind: 'frame', from: this.store.deviceId, to: message.from, frame: bytesToBase64(frame) });
        }
        this.onEvent({
          type: 'delta-sent',
          peer: message.from,
          entries: delta.leaderboardEntries.length,
          bytes: frames.reduce((sum, f) => sum + f.length, 0),
          frames: frames.length,
        });
        return;
      }

      case 'frame': {
        let assembler = this.assemblers.get(message.from);
        if (!assembler) {
          assembler = new FrameAssembler();
          this.assemblers.set(message.from, assembler);
        }
        const complete = assembler.push(base64ToBytes(message.frame));
        if (!complete) {
          return;
        }
        const delta = decodeBinaryPayload(complete);
        await this.store.apply(delta);
        this.onEvent({ type: 'delta-applied', peer: message.from, entries: delta.leaderboardEntries.length });
        return;
      }
    }
  }

  private async localDigest(): Promise<SyncDigest> {
    const { crdtState, leaderboard } = await this.store.load();
    return createDigest(this.store.deviceId, crdtState, leaderboard);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch(e => {
      this.onEvent({ type: 'error', error: e instanceof Error ? e.message : String(e) });
    });
    return this.queue;
  }
}

// ── Base64 (frames travel inside JSON messages on text transports) ──

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) {
      throw new Error(`Invalid base64 character: ${ch}`);
    }
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}
