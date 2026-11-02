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
 * Gossip delta frame size for BLE. A frame message adds ≤ 85 bytes of
 * codec header, so at MTU 517 each frame travels in a single write.
 */
export const BLE_GOSSIP_FRAME_BYTES = 420;

export type BleLinkRole = 'central' | 'peripheral';
export type BlePeerStatus = 'found' | 'connecting' | 'connected' | 'lost';

export interface BlePeer {
  /** Node tag (8 bytes hex) from the advertisement, or derived from the device ID. */
  tag: string;
  /** Gossip device ID, known after the first message on the link. */
  deviceId: string | null;
  status: BlePeerStatus;
  role: BleLinkRole | null;
  rssi: number | null;
  mtu: number | null;
  lastSeen: number;
}

interface Link {
  id: string; // BLE address / device id
  role: BleLinkRole;
  tag: string | null;
  deviceId: string | null;
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

  constructor(private readonly deviceId: string) {
    this.tag = nodeTagOf(deviceId);
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

    this.manager = new BleManager();
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
    this.nativeSubs.forEach(s => s.remove());
    this.nativeSubs = [];
    this.stateSub?.remove();
    this.stateSub = null;
    try {
      await BlePeripheral?.stop();
    } catch {}
    this.manager?.destroy();
    this.manager = null;
    this.emitPeers();
  }

  // ── Sending ────────────────────────────────────────────

  /**
   * Send a gossip message. Hashes go to every ready link; digests and
   * frames go to the link of the addressed device (or to all links until
   * that device has been heard from).
   */
  send(message: GossipMessage): void {
    const ready = Array.from(this.links.values()).filter(l => l.ready);
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

    let message: GossipMessage;
    try {
      message = decodeGossipMessage(complete);
    } catch (e: any) {
      this.onLog(`⚠️ Bad message from ${this.labelOf(link)}: ${e?.message ?? e}`);
      return;
    }

    if (link.deviceId !== message.from) {
      link.deviceId = message.from;
      link.tag = link.tag ?? nodeTagOf(message.from);
      this.linkByDevice.set(message.from, link.id);
      this.emitPeers();
    }
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
    }
    this.emitPeers();
  }

  private hasLinkForTag(tag: string): boolean {
    for (const link of this.links.values()) {
      if (link.tag === tag || (link.deviceId && nodeTagOf(link.deviceId) === tag)) return true;
    }
    return false;
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
        status: this.connecting.has(tag) ? 'connecting' : Date.now() - s.lastSeen > 15_000 ? 'lost' : 'found',
        role: null,
        rssi: s.rssi,
        mtu: null,
        lastSeen: s.lastSeen,
      });
    }
    for (const link of this.links.values()) {
      const tag = link.tag ?? (link.deviceId ? nodeTagOf(link.deviceId) : link.id);
      const s = this.seen.get(tag);
      peers.set(tag, {
        tag,
        deviceId: link.deviceId,
        status: link.ready ? 'connected' : 'connecting',
        role: link.role,
        rssi: s?.rssi ?? null,
        mtu: link.mtu,
        lastSeen: s?.lastSeen ?? Date.now(),
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
