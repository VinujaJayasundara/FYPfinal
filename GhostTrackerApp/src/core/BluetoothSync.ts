/**
 * BluetoothSync — dual-role BLE transport for the anti-entropy gossip
 * (thesis §2.7.1, §3.7.1, FRS-08).
 *
 * Every phone is at the same time:
 *   - Peripheral: GATT server + advertising (local Kotlin module ble-peripheral)
 *   - Central:    scanner + GATT client (react-native-ble-plx)
 *
 * One GATT connection per pair of phones. The phone with the smaller node
 * tag connects (Central); the other accepts (Peripheral). On that link the
 * Central writes to the peer's write characteristic and the Peripheral
 * answers with notifications, so the link carries messages both ways.
 *
 * Consent: links come up automatically so phones can learn each other's
 * names (a "hello"), but no leaderboard data moves until both runners agree:
 * one sends an invitation, the other accepts. Only paired peers receive
 * gossip, and gossip from unpaired peers is dropped. Pairing lasts while the
 * link is up.
 *
 * Each GossipMessage is packed with the binary gossip codec and split into
 * chunks of at most MTU − 3 bytes (splitIntoFrames); the receiver puts the
 * chunks back together with a FrameAssembler per link. The gossip protocol
 * itself (GossipSession) is the same one the Wi-Fi relay uses.
 */

import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, Device, ScanMode, State, Subscription } from 'react-native-ble-plx';
import { BlePeripheral } from '../../modules/ble-peripheral';
import {
  GossipMessage,
  encodeGossipMessage,
  decodeGossipMessage,
  splitIntoFrames,
  FrameAssembler,
  bytesToBase64,
  base64ToBytes,
  utf8Encode,
  utf8Decode,
} from '../../../GhostTracker/src/core/crdt';
import {
  BLE_SERVICE_UUID,
  BLE_SYNC_CHAR_UUID,
  BLE_STATE_CHAR_UUID,
} from '../../../GhostTracker/src/utils/constants';

/** Peers write to this characteristic. */
const WRITE_CHAR_UUID = BLE_SYNC_CHAR_UUID;
/** We notify on this characteristic. */
const NOTIFY_CHAR_UUID = BLE_STATE_CHAR_UUID;

/** MTU we ask for; Android's maximum (512 bytes of payload per write). */
const REQUESTED_MTU = 517;
/** ATT default before negotiation. */
const DEFAULT_MTU = 23;
/** At most 7 simultaneous links (thesis §3.7.1). */
const MAX_LINKS = 7;
/** Do not retry a connection to the same peer more often than this. */
const RECONNECT_BACKOFF_MS = 3000;
const CONNECT_TIMEOUT_MS = 10_000;
/** Manufacturer data prefix: test company ID 0xFFFF, little-endian. */
const COMPANY_ID_BYTES = [0xff, 0xff];

/**
 * Gossip delta frame size for BLE (core constant): each serialized frame
 * message stays ≤ 384 bytes (thesis NFR-04), one write at MTU ≥ 387.
 */
export { BLE_GOSSIP_FRAME_BYTES } from '../../../GhostTracker/src/utils/constants';

export type BleLinkRole = 'central' | 'peripheral';
export type BlePeerStatus = 'found' | 'connecting' | 'connected' | 'lost';
/** Consent state with a peer: we invited them, they invited us, or both agreed. */
export type BlePairing = 'invited-out' | 'invited-in' | 'paired';

/**
 * Control messages ride on the same link as gossip. They start with a byte
 * the gossip codec never uses as a kind (1-3), followed by UTF-8 JSON.
 */
const CONTROL_MARKER = 0xc0;
type ControlType = 'hello' | 'invite' | 'accept' | 'decline' | 'unpair' | 'race';
interface ControlMessage {
  t: ControlType;
  from: string;
  alias?: string;
  /** Race payload (only between paired runners). */
  r?: unknown;
}

export interface BlePeer {
  /** Node tag (8 bytes hex) from the advertisement, or derived from the device ID. */
  tag: string;
  /** Gossip device ID, known after the peer's hello. */
  deviceId: string | null;
  /** Runner name from the peer's hello. */
  alias: string | null;
  pairing: BlePairing | null;
  status: BlePeerStatus;
  role: BleLinkRole | null;
  rssi: number | null;
  mtu: number | null;
  lastSeen: number;
  /** BLE address of the peer (link or last advertisement). */
  address: string | null;
}

interface Link {
  id: string; // BLE address / device id
  role: BleLinkRole;
  tag: string | null;
  deviceId: string | null;
  alias: string | null;
  mtu: number;
  ready: boolean;
  assembler: FrameAssembler;
  seq: number;
  sending: Promise<void>;
  bytesIn: number;
  bytesOut: number;
  device?: Device;
  subs: Subscription[];
}

/**
 * 8-byte node tag (16 hex digits) from a device ID: two 32-bit FNV-1a hashes.
 * Deterministic, so a peer can compute the tag of a device ID it hears from.
 */
export function nodeTagOf(deviceId: string): string {
  const fnv = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < deviceId.length; i++) {
      h ^= deviceId.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  return fnv(0x811c9dc5) + fnv(0x2c1b3c6d);
}

function tagFromManufacturerData(base64: string | null): string | null {
  if (!base64) return null;
  const bytes = base64ToBytes(base64);
  if (bytes.length < 10 || bytes[0] !== COMPANY_ID_BYTES[0] || bytes[1] !== COMPANY_ID_BYTES[1]) {
    return null;
  }
  return Array.from(bytes.subarray(2, 10), b => b.toString(16).padStart(2, '0')).join('');
}

export class BluetoothSync {
  onMessage: (message: GossipMessage) => void = () => {};
  onPeersChange: (peers: BlePeer[]) => void = () => {};
  onLog: (msg: string) => void = () => {};
  /** A peer invited us; answer with accept() or decline(). */
  onInvite: (deviceId: string, alias: string) => void = () => {};
  /** A peer declined our invitation. */
  onDecline: (deviceId: string, alias: string) => void = () => {};
  /** Pairing with a peer started (paired) or ended (null). */
  onPairingChange: (deviceId: string, alias: string, pairing: BlePairing | null) => void = () => {};
  /** A race message from a paired runner. */
  onRace: (deviceId: string, payload: unknown) => void = () => {};

  private readonly tag: string;
  private manager: BleManager | null = null;
  private links = new Map<string, Link>();
  private linkByDevice = new Map<string, string>();
  private seen = new Map<string, { rssi: number | null; lastSeen: number; bleId: string }>();
  private lastAttempt = new Map<string, number>();
  private connecting = new Set<string>();
  private nativeSubs: { remove(): void }[] = [];
  private stateSub: Subscription | null = null;
  private started = false;
  private pairing = new Map<string, BlePairing>();
  /**
   * Runners who accepted during this Bluetooth session. If the link drops
   * (out of range, interference), they are re-paired automatically when it
   * comes back, without asking again. Cleared by stop() or unpair().
   */
  private trusted = new Set<string>();
  private readonly ownsManager: boolean;

  /**
   * @param manager Optional shared BleManager (react-native-ble-plx wants a
   *                single instance per app). If given, stop() leaves it alive.
   */
  constructor(
    private readonly deviceId: string,
    private alias: string,
    private readonly sharedManager: BleManager | null = null,
  ) {
    this.tag = nodeTagOf(deviceId);
    this.ownsManager = sharedManager === null;
  }

  /** Update our runner name; peers see it in the next hello. */
  setAlias(alias: string): void {
    if (alias === this.alias) return;
    this.alias = alias;
    for (const link of this.links.values()) {
      if (link.ready) this.sendControl(link, 'hello');
    }
  }

  get nodeTag(): string {
    return this.tag;
  }

  static isAvailable(): boolean {
    return Platform.OS === 'android' && BlePeripheral !== null;
  }

  // ── Lifecycle ──────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    if (!BluetoothSync.isAvailable()) {
      throw new Error('Bluetooth sync needs the Android development build');
    }
    await this.requestPermissions();

    this.manager = this.sharedManager ?? new BleManager();
    await this.waitForPoweredOn();

    this.listenPeripheral();
    await BlePeripheral!.start(BLE_SERVICE_UUID, WRITE_CHAR_UUID, NOTIFY_CHAR_UUID, this.tag);
    this.onLog(`📡 Advertising as ${this.tag.slice(0, 8)}… (GATT server up)`);

    this.manager.startDeviceScan(
      [BLE_SERVICE_UUID],
      { allowDuplicates: true, scanMode: ScanMode.LowLatency },
      (error, device) => {
        if (error) {
          this.onLog(`❌ Scan error: ${error.message}`);
          return;
        }
        if (device) this.onScan(device);
      },
    );
    this.onLog('🔍 Scanning for nearby EquiStride runners…');
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
    try {
      this.manager?.stopDeviceScan();
    } catch {}
    for (const link of this.links.values()) {
      link.subs.forEach(s => s.remove());
      if (link.role === 'central') {
        try {
          await this.manager?.cancelDeviceConnection(link.id);
        } catch {}
      }
    }
    this.links.clear();
    this.linkByDevice.clear();
    this.seen.clear();
    this.connecting.clear();
    this.pairing.clear();
    this.trusted.clear();
    this.nativeSubs.forEach(s => s.remove());
    this.nativeSubs = [];
    this.stateSub?.remove();
    this.stateSub = null;
    try {
      await BlePeripheral?.stop();
    } catch {}
    if (this.ownsManager) this.manager?.destroy();
    this.manager = null;
    this.emitPeers();
  }

  // -- Consent (invite / accept) ------------------------------

  /** Invite a nearby runner (by device ID, known from their hello). */
  invite(deviceId: string): boolean {
    const link = this.linkFor(deviceId);
    if (!link) return false;
    const state = this.pairing.get(deviceId);
    if (state === 'paired') return true;
    if (state === 'invited-in') return this.accept(deviceId);
    this.pairing.set(deviceId, 'invited-out');
    this.sendControl(link, 'invite');
    this.onLog(`✉️ Invitation sent to ${this.nameOf(link)}`);
    this.emitPeers();
    return true;
  }

  /** Accept a peer's invitation: from now on we sync with them. */
  accept(deviceId: string): boolean {
    const link = this.linkFor(deviceId);
    if (!link || this.pairing.get(deviceId) !== 'invited-in') return false;
    this.sendControl(link, 'accept');
    this.setPaired(link);
    return true;
  }

  decline(deviceId: string): void {
    const link = this.linkFor(deviceId);
    if (this.pairing.get(deviceId) === 'invited-in') this.pairing.delete(deviceId);
    if (link) this.sendControl(link, 'decline');
    this.emitPeers();
  }

  /** Send a race message to a paired runner. False if not paired / no link. */
  sendRace(deviceId: string, payload: unknown): boolean {
    const link = this.linkFor(deviceId);
    if (!link || this.pairing.get(deviceId) !== 'paired') return false;
    this.sendControl(link, 'race', payload);
    return true;
  }

  /** Stop syncing with a paired peer (the link itself stays up). */
  unpair(deviceId: string): void {
    this.trusted.delete(deviceId);
    const link = this.linkFor(deviceId);
    if (link) this.sendControl(link, 'unpair');
    if (this.pairing.has(deviceId)) {
      this.pairing.delete(deviceId);
      const name = link ? this.nameOf(link) : deviceId;
      this.onPairingChange(deviceId, name, null);
      this.onLog(`🚫 Stopped syncing with ${name}`);
    }
    this.emitPeers();
  }

  isPaired(deviceId: string): boolean {
    return this.pairing.get(deviceId) === 'paired';
  }

  private setPaired(link: Link): void {
    if (!link.deviceId) return;
    this.pairing.set(link.deviceId, 'paired');
    this.trusted.add(link.deviceId);
    this.onLog(`🤝 Paired with ${this.nameOf(link)}: leaderboards will sync`);
    this.onPairingChange(link.deviceId, this.nameOf(link), 'paired');
    this.emitPeers();
  }

  private sendControl(link: Link, t: ControlType, r?: unknown): void {
    const msg: ControlMessage = { t, from: this.deviceId };
    if (t === 'hello' || t === 'invite') msg.alias = this.alias;
    if (r !== undefined) msg.r = r;
    const json = utf8Encode(JSON.stringify(msg));
    const bytes = new Uint8Array(json.length + 1);
    bytes[0] = CONTROL_MARKER;
    bytes.set(json, 1);
    this.sendOnLink(link, bytes);
  }

  private onControl(link: Link, msg: ControlMessage): void {
    if (typeof msg.from !== 'string' || msg.from === this.deviceId) return;
    if (link.deviceId !== msg.from) {
      link.deviceId = msg.from;
      link.tag = link.tag ?? nodeTagOf(msg.from);
      this.linkByDevice.set(msg.from, link.id);
    }
    if (typeof msg.alias === 'string' && msg.alias) link.alias = msg.alias.slice(0, 40);
    const from = msg.from;
    const state = this.pairing.get(from);

    switch (msg.t) {
      case 'hello':
        // A runner we already accepted came back in range: re-pair silently
        if (!state && this.trusted.has(from)) {
          this.pairing.set(from, 'invited-out');
          this.sendControl(link, 'invite');
          this.onLog(`🔁 ${this.nameOf(link)} is back in range, reconnecting`);
        }
        break;
      case 'race':
        if (state === 'paired') this.onRace(from, msg.r);
        break;
      case 'invite':
        if (!state && this.trusted.has(from)) {
          this.sendControl(link, 'accept');
          this.setPaired(link);
        } else if (state === 'paired') {
          this.sendControl(link, 'accept'); // they lost our pairing; reconfirm
        } else if (state === 'invited-out') {
          // We invited each other: that is consent on both sides
          this.sendControl(link, 'accept');
          this.setPaired(link);
        } else {
          this.pairing.set(from, 'invited-in');
          this.onLog(`✉️ ${this.nameOf(link)} invited you to sync`);
          this.onInvite(from, this.nameOf(link));
        }
        break;
      case 'accept':
        if (state === 'invited-out') this.setPaired(link);
        break;
      case 'decline':
        if (state === 'invited-out') {
          this.pairing.delete(from);
          this.onLog(`🙅 ${this.nameOf(link)} declined your invitation`);
          this.onDecline(from, this.nameOf(link));
        }
        break;
      case 'unpair':
        if (state) {
          this.pairing.delete(from);
          this.onLog(`🚫 ${this.nameOf(link)} stopped syncing with you`);
          this.onPairingChange(from, this.nameOf(link), null);
        }
        break;
    }
    this.emitPeers();
  }

  // ── Sending ────────────────────────────────────────────

  /**
   * Send a gossip message. Hashes go to every ready link; digests and
   * frames go to the link of the addressed device (or to all links until
   * that device has been heard from).
   */
  send(message: GossipMessage): void {
    // Only runners who accepted (paired) receive leaderboard data
    const ready = Array.from(this.links.values()).filter(
      l => l.ready && l.deviceId !== null && this.pairing.get(l.deviceId) === 'paired',
    );
    if (ready.length === 0) return;

    let targets = ready;
    if (message.kind !== 'hash') {
      const linkId = this.linkByDevice.get(message.to);
      const link = linkId ? this.links.get(linkId) : undefined;
      if (link?.ready) targets = [link];
    }

    const bytes = encodeGossipMessage(message);
    for (const link of targets) {
      this.sendOnLink(link, bytes);
    }
  }

  /** MTU and RSSI of the link to a device, for the sync log. */
  linkStats(deviceId: string): { mtu: number | null; rssi: number | null; bytesIn: number; bytesOut: number } {
    const link = this.links.get(this.linkByDevice.get(deviceId) ?? '');
    const seen = this.seen.get(nodeTagOf(deviceId));
    return {
      mtu: link?.mtu ?? null,
      rssi: seen?.rssi ?? null,
      bytesIn: link?.bytesIn ?? 0,
      bytesOut: link?.bytesOut ?? 0,
    };
  }

  private sendOnLink(link: Link, bytes: Uint8Array): void {
    const chunks = splitIntoFrames(bytes, link.seq, link.mtu - 3);
    link.seq = (link.seq + 1) & 0xffff;
    link.sending = link.sending.then(async () => {
      for (const chunk of chunks) {
        if (!this.links.has(link.id)) return;
        const value = bytesToBase64(chunk);
        try {
          if (link.role === 'central') {
            await link.device!.writeCharacteristicWithResponseForService(BLE_SERVICE_UUID, WRITE_CHAR_UUID, value);
          } else {
            const ok = await BlePeripheral!.notify(link.id, value);
            if (!ok) throw new Error('peer is not subscribed');
          }
          link.bytesOut += chunk.length;
        } catch (e: any) {
          this.onLog(`⚠️ Send to ${this.labelOf(link)} failed: ${e?.message ?? e}`);
          return;
        }
      }
    });
  }

  // ── Receiving ──────────────────────────────────────────

  private onChunk(link: Link, base64: string): void {
    const chunk = base64ToBytes(base64);
    link.bytesIn += chunk.length;
    const complete = link.assembler.push(chunk);
    if (!complete) return;

    if (complete[0] === CONTROL_MARKER) {
      try {
        this.onControl(link, JSON.parse(utf8Decode(complete.subarray(1))) as ControlMessage);
      } catch (e: any) {
        this.onLog(`⚠️ Bad control message from ${this.labelOf(link)}: ${e?.message ?? e}`);
      }
      return;
    }

    let message: GossipMessage;
    try {
      message = decodeGossipMessage(complete);
    } catch (e: any) {
      this.onLog(`⚠️ Bad message from ${this.labelOf(link)}: ${e?.message ?? e}`);
      return;
    }

    // Drop leaderboard data from anyone we have not paired with
    if (link.deviceId !== message.from || this.pairing.get(message.from) !== 'paired') return;
    this.onMessage(message);
  }

  // ── Central role (ble-plx) ─────────────────────────────

  private onScan(device: Device): void {
    const tag = tagFromManufacturerData(device.manufacturerData);
    if (!tag || tag === this.tag) return;

    const isNew = !this.seen.has(tag);
    this.seen.set(tag, { rssi: device.rssi ?? null, lastSeen: Date.now(), bleId: device.id });
    if (isNew) {
      this.onLog(`📱 Found runner ${tag.slice(0, 8)}… (RSSI ${device.rssi ?? '?'} dBm)`);
    }
    this.emitPeers();

    // Only the smaller tag connects, so each pair has exactly one link.
    if (this.tag > tag) return;
    if (this.hasLinkForTag(tag) || this.connecting.has(tag)) return;
    if (this.links.size >= MAX_LINKS) return;
    if (Date.now() - (this.lastAttempt.get(tag) ?? 0) < RECONNECT_BACKOFF_MS) return;

    this.lastAttempt.set(tag, Date.now());
    this.connectTo(device, tag);
  }

  private async connectTo(scanned: Device, tag: string): Promise<void> {
    const manager = this.manager;
    if (!manager) return;
    this.connecting.add(tag);
    this.emitPeers();
    this.onLog(`🔗 Connecting to ${tag.slice(0, 8)}…`);

    try {
      const device = await manager.connectToDevice(scanned.id, { requestMTU: REQUESTED_MTU, timeout: CONNECT_TIMEOUT_MS });
      await device.discoverAllServicesAndCharacteristics();

      const link: Link = {
        id: device.id,
        role: 'central',
        tag,
        deviceId: null,
        alias: null,
        mtu: device.mtu || DEFAULT_MTU,
        ready: false,
        assembler: new FrameAssembler(),
        seq: 0,
        sending: Promise.resolve(),
        bytesIn: 0,
        bytesOut: 0,
        device,
        subs: [],
      };
      this.links.set(link.id, link);

      link.subs.push(
        device.monitorCharacteristicForService(BLE_SERVICE_UUID, NOTIFY_CHAR_UUID, (error, characteristic) => {
          if (error) return; // reported through onDeviceDisconnected
          if (characteristic?.value) this.onChunk(link, characteristic.value);
        }),
      );
      link.subs.push(
        manager.onDeviceDisconnected(device.id, () => {
          this.onLog(`👋 Lost link to ${this.labelOf(link)}`);
          this.dropLink(link.id);
        }),
      );
      link.ready = true;
      this.onLog(`✅ Connected to ${tag.slice(0, 8)}… (MTU ${link.mtu})`);
      this.sendControl(link, 'hello');
    } catch (e: any) {
      this.onLog(`❌ Connection to ${tag.slice(0, 8)}… failed: ${e?.message ?? e}`);
      try {
        await manager.cancelDeviceConnection(scanned.id);
      } catch {}
    } finally {
      this.connecting.delete(tag);
      this.emitPeers();
    }
  }

  // ── Peripheral role (Kotlin module) ────────────────────

  private listenPeripheral(): void {
    const p = BlePeripheral!;
    this.nativeSubs.push(
      p.addListener('onConnectionChange', ({ address, connected }) => {
        if (connected) {
          if (!this.links.has(address)) {
            this.links.set(address, {
              id: address,
              role: 'peripheral',
              tag: null,
              deviceId: null,
              alias: null,
              mtu: DEFAULT_MTU,
              ready: false,
              assembler: new FrameAssembler(),
              seq: 0,
              sending: Promise.resolve(),
              bytesIn: 0,
              bytesOut: 0,
              subs: [],
            });
            this.onLog(`🔗 Runner connected to us (${address})`);
          }
        } else {
          const link = this.links.get(address);
          if (link?.role === 'peripheral') {
            this.onLog(`👋 ${this.labelOf(link)} disconnected`);
            this.dropLink(address);
          }
        }
        this.emitPeers();
      }),
      p.addListener('onSubscribe', ({ address, subscribed }) => {
        const link = this.links.get(address);
        if (link?.role === 'peripheral') {
          link.ready = subscribed;
          if (subscribed) this.sendControl(link, 'hello');
          this.emitPeers();
        }
      }),
      p.addListener('onMtuChanged', ({ address, mtu }) => {
        const link = this.links.get(address);
        if (link) {
          link.mtu = mtu;
          this.emitPeers();
        }
      }),
      p.addListener('onWrite', ({ address, value }) => {
        const link = this.links.get(address);
        if (link?.role === 'peripheral') this.onChunk(link, value);
      }),
    );
  }

  // ── Helpers ────────────────────────────────────────────

  private dropLink(id: string): void {
    const link = this.links.get(id);
    if (!link) return;
    link.subs.forEach(s => s.remove());
    link.assembler.reset();
    this.links.delete(id);
    if (link.deviceId && this.linkByDevice.get(link.deviceId) === id) {
      this.linkByDevice.delete(link.deviceId);
      // Consent lasts only while the link is up
      const was = this.pairing.get(link.deviceId);
      if (was) {
        this.pairing.delete(link.deviceId);
        if (was === 'paired') this.onPairingChange(link.deviceId, this.nameOf(link), null);
      }
    }
    this.emitPeers();
  }

  private hasLinkForTag(tag: string): boolean {
    for (const link of this.links.values()) {
      if (link.tag === tag || (link.deviceId && nodeTagOf(link.deviceId) === tag)) return true;
    }
    return false;
  }

  private linkFor(deviceId: string): Link | undefined {
    const link = this.links.get(this.linkByDevice.get(deviceId) ?? '');
    return link?.ready ? link : undefined;
  }

  private nameOf(link: Link): string {
    return link.alias ?? this.labelOf(link);
  }

  private labelOf(link: Link): string {
    return link.deviceId ?? (link.tag ? `${link.tag.slice(0, 8)}…` : link.id);
  }

  private emitPeers(): void {
    const peers = new Map<string, BlePeer>();
    for (const [tag, s] of this.seen) {
      peers.set(tag, {
        tag,
        deviceId: null,
        alias: null,
        pairing: null,
        status: this.connecting.has(tag) ? 'connecting' : Date.now() - s.lastSeen > 15_000 ? 'lost' : 'found',
        role: null,
        rssi: s.rssi,
        mtu: null,
        lastSeen: s.lastSeen,
        address: s.bleId,
      });
    }
    for (const link of this.links.values()) {
      const tag = link.tag ?? (link.deviceId ? nodeTagOf(link.deviceId) : link.id);
      const s = this.seen.get(tag);
      peers.set(tag, {
        tag,
        deviceId: link.deviceId,
        alias: link.alias,
        pairing: link.deviceId ? this.pairing.get(link.deviceId) ?? null : null,
        status: link.ready ? 'connected' : 'connecting',
        role: link.role,
        rssi: s?.rssi ?? null,
        mtu: link.mtu,
        lastSeen: s?.lastSeen ?? Date.now(),
        address: link.id,
      });
    }
    this.onPeersChange(Array.from(peers.values()));
  }

  private waitForPoweredOn(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stateSub?.remove();
        reject(new Error('Bluetooth is off. Turn it on and try again.'));
      }, 10_000);
      this.stateSub = this.manager!.onStateChange(state => {
        if (state === State.PoweredOn) {
          clearTimeout(timer);
          this.stateSub?.remove();
          this.stateSub = null;
          resolve();
        }
      }, true);
    });
  }

  private async requestPermissions(): Promise<void> {
    if (Platform.OS !== 'android') return;
    const sdk = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10);
    const wanted =
      sdk >= 31
        ? [
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
          ]
        : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
    const result = await PermissionsAndroid.requestMultiple(wanted);
    const denied = wanted.filter(p => result[p] !== PermissionsAndroid.RESULTS.GRANTED);
    if (denied.length > 0) {
      throw new Error(`Bluetooth permission denied: ${denied.map(p => p.split('.').pop()).join(', ')}`);
    }
  }
}
