/**
 * Binary codec for gossip messages on byte transports (BLE GATT).
 *
 * The Wi-Fi relay carries GossipMessage objects as JSON with base64 frames.
 * Over BLE every byte costs air time, so each message is packed as:
 *
 *   u8 kind (1 = hash, 2 = digest, 3 = frame) · str from · …
 *   hash    16 raw hash bytes
 *   digest  str to · str deviceId · u16 n · n × (str replicaId, u32 count)
 *           · u16 m · m × (str leaderboardKey, f64 updatedAt)
 *   frame   str to · remaining bytes = the binary delta frame
 *
 * str = u8 byte length + UTF-8 bytes (IDs and keys are short).
 * Numbers are little-endian. A hash message for a 29-character device ID
 * is 47 bytes.
 */

import { GossipMessage, base64ToBytes, bytesToBase64 } from './gossipSession';
import { utf8Decode, utf8Encode } from './stateVector';
import { STATE_HASH_BYTES } from '../../utils/constants';

const KIND_HASH = 1;
const KIND_DIGEST = 2;
const KIND_FRAME = 3;

class Writer {
  private buf = new Uint8Array(128);
  private view = new DataView(this.buf.buffer);
  private pos = 0;

  private ensure(extra: number): void {
    if (this.pos + extra <= this.buf.length) {
      return;
    }
    let size = this.buf.length * 2;
    while (size < this.pos + extra) {
      size *= 2;
    }
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
  }

  u16(v: number): void {
    if (v > 0xffff) {
      throw new Error(`Count ${v} does not fit in u16`);
    }
    this.ensure(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
  }

  f64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  str(s: string): void {
    const bytes = utf8Encode(s);
    if (bytes.length > 255) {
      throw new Error(`String too long for the gossip codec (${bytes.length} bytes): ${s.slice(0, 40)}…`);
    }
    this.u8(bytes.length);
    this.bytes(bytes);
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

class Reader {
  private readonly view: DataView;
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new Error('Gossip message truncated');
    }
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  str(): string {
    const len = this.u8();
    return utf8Decode(this.take(len));
  }

  take(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  rest(): Uint8Array {
    return this.take(this.buf.length - this.pos);
  }

  done(): boolean {
    return this.pos === this.buf.length;
  }
}

/**
 * Pack a gossip message into bytes for a BLE characteristic write or notification.
 */
export function encodeGossipMessage(message: GossipMessage): Uint8Array {
  const w = new Writer();
  switch (message.kind) {
    case 'hash': {
      const hash = base64ToBytes(message.hash);
      if (hash.length !== STATE_HASH_BYTES) {
        throw new Error(`State hash must be ${STATE_HASH_BYTES} bytes, got ${hash.length}`);
      }
      w.u8(KIND_HASH);
      w.str(message.from);
      w.bytes(hash);
      break;
    }
    case 'digest': {
      const { digest } = message;
      w.u8(KIND_DIGEST);
      w.str(message.from);
      w.str(message.to);
      w.str(digest.deviceId);
      const replicas = Object.entries(digest.crdtState);
      w.u16(replicas.length);
      for (const [replicaId, count] of replicas) {
        w.str(replicaId);
        w.u32(count);
      }
      const entries = Object.entries(digest.entries);
      w.u16(entries.length);
      for (const [key, updatedAt] of entries) {
        w.str(key);
        w.f64(updatedAt);
      }
      break;
    }
    case 'frame': {
      w.u8(KIND_FRAME);
      w.str(message.from);
      w.str(message.to);
      w.bytes(base64ToBytes(message.frame));
      break;
    }
  }
  return w.finish();
}

/**
 * Unpack bytes produced by encodeGossipMessage.
 *
 * @throws Error if the bytes are truncated, have trailing data or an unknown kind
 */
export function decodeGossipMessage(bytes: Uint8Array): GossipMessage {
  const r = new Reader(bytes);
  const kind = r.u8();
  const from = r.str();
  let message: GossipMessage;

  switch (kind) {
    case KIND_HASH:
      message = { kind: 'hash', from, hash: bytesToBase64(r.take(STATE_HASH_BYTES)) };
      break;
    case KIND_DIGEST: {
      const to = r.str();
      const deviceId = r.str();
      const crdtState: Record<string, number> = {};
      const replicaCount = r.u16();
      for (let i = 0; i < replicaCount; i++) {
        const replicaId = r.str();
        crdtState[replicaId] = r.u32();
      }
      const entries: Record<string, number> = {};
      const entryCount = r.u16();
      for (let i = 0; i < entryCount; i++) {
        const key = r.str();
        entries[key] = r.f64();
      }
      message = { kind: 'digest', from, to, digest: { deviceId, crdtState, entries } };
      break;
    }
    case KIND_FRAME: {
      const to = r.str();
      return { kind: 'frame', from, to, frame: bytesToBase64(r.rest()) };
    }
    default:
      throw new Error(`Unknown gossip message kind ${kind}`);
  }

  if (!r.done()) {
    throw new Error('Trailing bytes after gossip message');
  }
  return message;
}
