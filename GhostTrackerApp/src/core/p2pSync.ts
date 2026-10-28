/**
 * Ghost-Tracker — P2P Sync Service (WebSocket)
 * ===============================================
 * Manages a WebSocket connection to the relay server for real
 * cross-device CRDT synchronization over local Wi-Fi.
 *
 * Usage:
 *   const p2p = new P2PSyncService();
 *   p2p.onLog = (msg) => console.log(msg);
 *   p2p.onPayloadReceived = (payload) => handleMerge(payload);
 *   await p2p.connect('192.168.1.5:8080', 'device-id', 'Vinuja');
 *   p2p.sendPayload(mySyncPayload);
 *   p2p.disconnect();
 */

import type { GossipMessage } from '../../../GhostTracker/src/core/crdt';
import { SyncPayload } from './sync';

export type P2PStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface PeerInfo {
  deviceId: string;
  alias: string;
}

/**
 * Live race stats shared with peers during a run.
 * Deliberately contains no coordinates: raw GPS never leaves the device,
 * only derived scalar metrics are broadcast.
 */
export interface LivePosition {
  deviceId: string;
  alias: string;
  distanceM: number;
  elapsedS: number;
  avgPaceSPerKm: number;
  currentPaceSPerKm: number;
  npiScore: number | null;
  timestamp: number;
}

export class P2PSyncService {
  private ws: WebSocket | null = null;
  private _status: P2PStatus = 'disconnected';
  private _peerCount: number = 0;
  private retryCount: number = 0;
  private maxRetries: number = 3;
  private serverUrl: string = '';
  private deviceId: string = '';
  private alias: string = '';

  // ── Event callbacks ─────────────────────────────────────
  onStatusChange: ((status: P2PStatus) => void) | null = null;
  onPeerCountChange: ((count: number) => void) | null = null;
  onPeerJoined: ((peer: PeerInfo) => void) | null = null;
  onPeerLeft: ((peer: PeerInfo) => void) | null = null;
  onPeerListReceived: ((peers: PeerInfo[]) => void) | null = null;
  onPayloadReceived: ((payload: SyncPayload) => void) | null = null;
  onLivePositionReceived: ((pos: LivePosition) => void) | null = null;
  onGossipReceived: ((message: GossipMessage) => void) | null = null;
  onLog: ((message: string) => void) | null = null;

  // ── Getters ─────────────────────────────────────────────

  get status(): P2PStatus {
    return this._status;
  }

  get peerCount(): number {
    return this._peerCount;
  }

  get isConnected(): boolean {
    return this._status === 'connected';
  }

  // ── Connect ─────────────────────────────────────────────

  connect(serverAddress: string, deviceId: string, alias: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.log('⚠️ Already connected. Disconnect first.');
        resolve();
        return;
      }

      this.serverUrl = serverAddress;
      this.deviceId = deviceId;
      this.alias = alias;
      this.retryCount = 0;

      this.setStatus('connecting');

      // Ensure proper ws:// prefix
      const url = serverAddress.startsWith('ws://')
        ? serverAddress
        : `ws://${serverAddress}`;

      this.log(`🔗 Connecting to relay: ${url}...`);

      try {
        this.ws = new WebSocket(url);
      } catch (e: any) {
        this.setStatus('error');
        this.log(`❌ Failed to create WebSocket: ${e.message}`);
        reject(e);
        return;
      }

      const timeout = setTimeout(() => {
        if (this._status === 'connecting') {
          this.log('⏰ Connection timed out after 5s');
          this.setStatus('error');
          this.ws?.close();
          reject(new Error('Connection timeout'));
        }
      }, 5000);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        this.setStatus('connected');
        this.retryCount = 0;
        this.log('✅ Connected to relay server!');

        // Register with the relay
        this.send({
          type: 'REGISTER',
          deviceId: this.deviceId,
          alias: this.alias,
        });

        resolve();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data.toString());
      };

      this.ws.onerror = (event: Event) => {
        clearTimeout(timeout);
        this.log(`❌ WebSocket error`);
        this.setStatus('error');
      };

      this.ws.onclose = (event: CloseEvent) => {
        clearTimeout(timeout);
        const wasConnected = this._status === 'connected';
        this.setStatus('disconnected');
        this._peerCount = 0;
        this.onPeerCountChange?.(0);

        if (wasConnected) {
          this.log(`📴 Disconnected from relay (code: ${event.code})`);

          // Auto-reconnect if unexpected disconnect
          if (event.code !== 1000 && this.retryCount < this.maxRetries) {
            this.retryCount++;
            this.log(`🔄 Reconnecting... (attempt ${this.retryCount}/${this.maxRetries})`);
            setTimeout(() => {
              this.connect(this.serverUrl, this.deviceId, this.alias).catch(() => {});
            }, 2000);
          }
        }
      };
    });
  }

  // ── Disconnect ──────────────────────────────────────────

  disconnect(): void {
    this.retryCount = this.maxRetries; // Prevent auto-reconnect
    if (this.ws) {
      this.ws.close(1000, 'User disconnected');
      this.ws = null;
    }
    this.setStatus('disconnected');
    this._peerCount = 0;
    this.onPeerCountChange?.(0);
    this.log('🔌 Disconnected.');
  }

  // ── Send Sync Payload ───────────────────────────────────

  sendPayload(payload: SyncPayload): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log('❌ Cannot send — not connected to relay.');
      return false;
    }

    const message = JSON.stringify({
      type: 'SYNC_PAYLOAD',
      ...payload,
    });

    const sizeBytes = new TextEncoder().encode(message).length;
    this.ws.send(message);
    this.log(`📤 Broadcast sync payload (${sizeBytes} bytes) to ${this._peerCount} peer(s)`);
    return true;
  }

  // ── Send Live Position ──────────────────────────────────

  broadcastPosition(pos: LivePosition): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'LIVE_POSITION', ...pos }));
  }

  // ── Send Gossip Message ─────────────────────────────────

  sendGossip(message: GossipMessage): void {
    this.send({ type: 'GOSSIP', message });
  }

  // ── Internal ────────────────────────────────────────────

  private send(data: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);

      switch (msg.type) {
        case 'PEER_COUNT':
          // The relay tells us how many clients are connected (including us)
          this._peerCount = Math.max(0, (msg.count || 1) - 1);
          this.onPeerCountChange?.(this._peerCount);
          this.log(`👥 Peers in room: ${this._peerCount}`);
          break;

        case 'PEER_JOINED':
          this.log(`📱 Peer joined: ${msg.alias} (${msg.deviceId})`);
          this.onPeerJoined?.({ deviceId: msg.deviceId, alias: msg.alias });
          break;

        case 'PEER_LEFT':
          this.log(`📴 Peer left: ${msg.alias}`);
          this.onPeerLeft?.({ deviceId: msg.deviceId, alias: msg.alias });
          break;

        case 'PEER_LIST': {
          const peers: PeerInfo[] = (msg.peers || []).map((p: any) => ({
            deviceId: p.deviceId,
            alias: p.alias,
          }));
          this.log(`📋 Peer list received: ${peers.length} peer(s)`);
          this.onPeerListReceived?.(peers);
          break;
        }

        case 'SYNC_PAYLOAD': {
          // Extract the SyncPayload from the relay message
          const payload: SyncPayload = {
            deviceId: msg.deviceId,
            timestamp: msg.timestamp,
            crdtState: msg.crdtState,
            leaderboardEntries: msg.leaderboardEntries,
            version: msg.version,
          };
          this.log(`📡 Received sync payload from ${msg.deviceId}`);
          this.onPayloadReceived?.(payload);
          break;
        }

        case 'LIVE_POSITION': {
          const pos: LivePosition = {
            deviceId: msg.deviceId,
            alias: msg.alias,
            distanceM: msg.distanceM,
            elapsedS: msg.elapsedS,
            avgPaceSPerKm: msg.avgPaceSPerKm,
            currentPaceSPerKm: msg.currentPaceSPerKm,
            npiScore: msg.npiScore,
            timestamp: msg.timestamp,
          };
          this.onLivePositionReceived?.(pos);
          break;
        }

        case 'GOSSIP':
          if (msg.message) {
            this.onGossipReceived?.(msg.message as GossipMessage);
          }
          break;

        default:
          this.log(`❓ Unknown relay message: ${msg.type}`);
      }
    } catch (e: any) {
      this.log(`❌ Failed to parse relay message: ${e.message}`);
    }
  }

  private setStatus(status: P2PStatus): void {
    this._status = status;
    this.onStatusChange?.(status);
  }

  private log(msg: string): void {
    this.onLog?.(msg);
  }
}
