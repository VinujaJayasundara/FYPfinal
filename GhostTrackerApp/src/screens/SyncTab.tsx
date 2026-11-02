import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform, TextInput, Alert, Share } from 'react-native';
import { useProfile } from '../context/ProfileContext';
import { useRun } from '../context/RunContext';
import {
  getCRDTState,
  getLeaderboard,
  saveSyncState,
  insertSyncLog,
  getSyncLog,
  getSyncLogCsv,
  clearSyncLog,
} from '../data/database';
import { SyncPayload, mergeSyncPayloads, toCoreEntry, toDBPayload } from '../core/sync';
import { P2PSyncService, P2PStatus } from '../core/p2pSync';
import { BluetoothSync, BlePeer, BLE_GOSSIP_FRAME_BYTES } from '../core/BluetoothSync';
import { GossipSession, GossipEvent } from '../../../GhostTracker/src/core/crdt';
import { GOSSIP_INTERVAL_MS } from '../../../GhostTracker/src/utils/constants';
import { RUNNER_PROFILES } from '../data/mockData';

const C = {
  bg: '#000000',
  surface: '#1C1C1E',
  surfaceElevated: '#2C2C2E',
  separator: '#38383A',
  accent: '#00FF87',
  accentDim: '#00FF8730',
  teal: '#00D4AA',
  red: '#FF3B30',
  amber: '#FF9F0A',
  blue: '#0A84FF',
  gold: '#FFD60A',
};

// Mock device IDs for the simulator
const MOCK_DEVICES = {
  'Tharindu': 'device-tharindu-001',
  'Supun': 'device-supun-002',
  'Kasun': 'device-kasun-003',
  'Jayavi': 'device-jayavi-004',
};

export function SyncTab() {
  const { profile } = useProfile();
  const { dbVersion, incrementDbVersion } = useRun();
  const [logs, setLogs] = useState<string[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [broadcastChannel, setBroadcastChannel] = useState<any>(null);

  // ── P2P State ──────────────────────────────────────────
  const p2pRef = useRef<P2PSyncService | null>(null);
  const [serverAddress, setServerAddress] = useState('172.20.10.4:8080');
  const [p2pStatus, setP2PStatus] = useState<P2PStatus>('disconnected');
  const [peerCount, setPeerCount] = useState(0);
  const [syncedPeers, setSyncedPeers] = useState<any[]>([]);

  // ── Anti-entropy gossip (automatic sync while connected) ──
  const gossipRef = useRef<GossipSession | null>(null);
  const peerAliasesRef = useRef<Record<string, string>>({});
  const [gossipStatus, setGossipStatus] = useState('Idle');

  // ── Transport: Bluetooth (dual-role BLE) or Wi-Fi relay ──
  const bleAvailable = BluetoothSync.isAvailable();
  const [transport, setTransport] = useState<'ble' | 'relay'>(bleAvailable ? 'ble' : 'relay');
  const bleRef = useRef<BluetoothSync | null>(null);
  const [bleRunning, setBleRunning] = useState(false);
  const [bleStarting, setBleStarting] = useState(false);
  const [blePeers, setBlePeers] = useState<BlePeer[]>([]);
  const [syncLogCount, setSyncLogCount] = useState(0);

  // Per-peer measurement of one sync: from the first hash mismatch to in-sync
  const pendingSyncRef = useRef<Record<string, {
    startedAt: number;
    bytesSent: number;
    framesSent: number;
    entriesSent: number;
    entriesReceived: number;
    bytesInAtStart: number;
  }>>({});

  // ── Load Synced Peers ──────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const board = await getLeaderboard();
        setSyncedPeers(board.filter(e => e.device_id !== profile.deviceId));
      } catch (e) {
        console.error(e);
      }
    })();
  }, [dbVersion, profile.deviceId]);

  const addLog = useCallback((msg: string) => {
    const time = new Date().toISOString().split('T')[1].substring(0, 8);
    setLogs(prev => [...prev, `[${time}] ${msg}`]);
  }, []);

  // ── Initialize P2P Service ─────────────────────────────
  useEffect(() => {
    const service = new P2PSyncService();

    service.onLog = (msg) => addLog(msg);
    service.onStatusChange = (status) => setP2PStatus(status);
    service.onPeerCountChange = (count) => setPeerCount(count);

    service.onPeerJoined = (peer) => {
      peerAliasesRef.current[peer.deviceId] = peer.alias;
      addLog(`🎉 ${peer.alias} joined the sync room!`);
    };

    service.onPeerListReceived = (peers) => {
      peers.forEach(p => { peerAliasesRef.current[p.deviceId] = p.alias; });
    };

    service.onPeerLeft = (peer) => {
      gossipRef.current?.forgetPeer(peer.deviceId);
      addLog(`👋 ${peer.alias} left the sync room.`);
    };

    service.onPayloadReceived = async (payload) => {
      addLog(`📡 Received real sync payload from peer: ${payload.deviceId}`);
      await handleIncomingRef.current(payload, { notify: true });
    };

    service.onGossipReceived = (message) => {
      gossipRef.current?.receive(message);
    };

    p2pRef.current = service;

    return () => {
      service.disconnect();
    };
  }, []);

  // ── Initialize BroadcastChannel on Web ─────────────────
  useEffect(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      const bc = new window.BroadcastChannel('ghost-tracker-p2p');
      setBroadcastChannel(bc);

      bc.onmessage = async (event: any) => {
        if (!event.data || event.data.type !== 'SYNC_PAYLOAD') return;
        const payload = event.data.payload as SyncPayload;
        if (payload.deviceId === profile.deviceId) return;
        addLog(`📡 [BroadcastChannel] Received payload from ${payload.deviceId}`);
        await handleIncomingPayload(payload);
      };

      return () => bc.close();
    }
  }, [profile.deviceId]);

  // ── Core Merge Handler ─────────────────────────────────

  const createLocalPayload = async (): Promise<SyncPayload> => {
    const crdtState = await getCRDTState();
    const leaderboard = await getLeaderboard();
    return {
      deviceId: profile.deviceId,
      timestamp: Date.now(),
      crdtState,
      leaderboardEntries: leaderboard,
      version: 1,
    };
  };

  const handleIncomingPayload = async (
    remotePayload: SyncPayload,
    { notify }: { notify: boolean } = { notify: true },
  ) => {
    try {
      const localCRDT = await getCRDTState();
      const localLeaderboard = await getLeaderboard();

      addLog(`⚙️ Merging CRDT states... Local: ${localLeaderboard.length} entries, Remote: ${remotePayload.leaderboardEntries.length} entries`);

      let peerAlias = 'Peer';
      let bestRII = -1;
      let peerNPI = 0;
      remotePayload.leaderboardEntries.forEach(e => {
        if (e.device_id === remotePayload.deviceId && e.rii_score > bestRII) {
          bestRII = e.rii_score;
          peerNPI = e.npi_score || 0;
          peerAlias = e.user_alias;
        }
      });
      
      if (notify && bestRII > -1) {
        const msg = `${peerAlias} synced their stats!\n\nTheir PR (RII): ${bestRII.toFixed(2)}\nTheir NPI: ${peerNPI.toFixed(2)}\n\nCompare scores to see if you're falling behind!`;
        if (Platform.OS === 'web') {
          window.alert(msg);
        } else {
          Alert.alert('Peer Synced!', msg);
        }
      }

      const result = mergeSyncPayloads(
        profile.deviceId,
        localCRDT,
        localLeaderboard,
        remotePayload
      );

      addLog(`✨ LWW Resolution: ${result.newEntriesCount} new, ${result.updatedEntriesCount} updated`);
      addLog(`🛡️ Social Consensus: ${result.witnessUpdates.length} witness signatures added`);

      if (result.hasChanges) {
        await saveSyncState(result.mergedCRDTState, result.mergedLeaderboard, result.witnessUpdates);
        addLog(`💾 Saved converged state to SQLite.`);
        incrementDbVersion();
      } else {
        addLog(`✅ State is already fully converged. No changes.`);
      }
    } catch (e) {
      addLog(`❌ Sync Error: ${e}`);
    }
  };

  // Long-lived callbacks (relay service, gossip session) call through this
  // ref so they always use the latest profile and render state.
  const handleIncomingRef = useRef(handleIncomingPayload);
  handleIncomingRef.current = handleIncomingPayload;

  // ── Gossip Session Lifecycle ───────────────────────────
  // While a transport is up (Bluetooth running, or connected to the relay),
  // run anti-entropy rounds every 2.5 s:
  // hash broadcast → digest on mismatch → delta in binary frames.
  const gossipActive = transport === 'ble' ? bleRunning : p2pStatus === 'connected';

  useEffect(() => {
    const relay = p2pRef.current;
    const ble = bleRef.current;
    if (!gossipActive || !profile.deviceId || (transport === 'relay' ? !relay : !ble)) {
      return;
    }

    const aliasOf = (id: string) => peerAliasesRef.current[id] ?? id.substring(0, 8);
    const pending = pendingSyncRef.current;
    const bytesInOf = (peer: string) => (transport === 'ble' ? ble?.linkStats(peer).bytesIn ?? 0 : 0);

    const onEvent = (e: GossipEvent) => {
      switch (e.type) {
        case 'mismatch':
          setGossipStatus(`Syncing with ${aliasOf(e.peer)}...`);
          addLog(`🔁 Gossip: state differs from ${aliasOf(e.peer)}, exchanging digests`);
          pending[e.peer] = {
            startedAt: Date.now(),
            bytesSent: 0,
            framesSent: 0,
            entriesSent: 0,
            entriesReceived: 0,
            bytesInAtStart: bytesInOf(e.peer),
          };
          break;
        case 'in-sync': {
          setGossipStatus(`In sync with ${aliasOf(e.peer)}`);
          const p = pending[e.peer];
          delete pending[e.peer];
          if (p) {
            const tSyncMs = Date.now() - p.startedAt;
            const stats = transport === 'ble' ? ble?.linkStats(e.peer) : undefined;
            addLog(`✅ Gossip: in sync with ${aliasOf(e.peer)} after ${(tSyncMs / 1000).toFixed(2)} s`);
            insertSyncLog({
              transport,
              peer_id: e.peer,
              started_at: p.startedAt,
              t_sync_ms: tSyncMs,
              bytes_sent: p.bytesSent,
              bytes_received: stats ? stats.bytesIn - p.bytesInAtStart : 0,
              frames_sent: p.framesSent,
              entries_sent: p.entriesSent,
              entries_received: p.entriesReceived,
              mtu: stats?.mtu ?? null,
              rssi: stats?.rssi ?? null,
            })
              .then(() => setSyncLogCount(c => c + 1))
              .catch(err => addLog(`⚠️ Could not save sync log: ${err}`));
          } else {
            addLog(`✅ Gossip: in sync with ${aliasOf(e.peer)}`);
          }
          break;
        }
        case 'delta-sent': {
          addLog(`📤 Gossip: sent ${e.entries} entr${e.entries === 1 ? 'y' : 'ies'} to ${aliasOf(e.peer)} (${e.bytes} B in ${e.frames} frame${e.frames === 1 ? '' : 's'})`);
          const p = pending[e.peer];
          if (p) {
            p.bytesSent += e.bytes;
            p.framesSent += e.frames;
            p.entriesSent += e.entries;
          }
          break;
        }
        case 'delta-applied': {
          addLog(`📥 Gossip: received ${e.entries} entr${e.entries === 1 ? 'y' : 'ies'} from ${aliasOf(e.peer)}`);
          const p = pending[e.peer];
          if (p) p.entriesReceived += e.entries;
          break;
        }
        case 'error':
          addLog(`❌ Gossip error: ${e.error}`);
          break;
      }
    };

    const session = new GossipSession(
      {
        deviceId: profile.deviceId,
        load: async () => ({
          crdtState: await getCRDTState(),
          leaderboard: (await getLeaderboard()).map(toCoreEntry),
        }),
        apply: delta => handleIncomingRef.current(toDBPayload(delta), { notify: false }),
      },
      message => (transport === 'ble' ? ble!.send(message) : relay!.sendGossip(message)),
      // Over BLE a delta frame plus its codec header must fit one 512-byte write
      { onEvent, maxFrameBytes: transport === 'ble' ? BLE_GOSSIP_FRAME_BYTES : undefined },
    );

    gossipRef.current = session;
    session.start();
    setGossipStatus('Running');
    addLog(`🔁 Anti-entropy gossip started over ${transport === 'ble' ? 'Bluetooth' : 'Wi-Fi relay'} (every ${GOSSIP_INTERVAL_MS / 1000} s)`);

    return () => {
      session.stop();
      gossipRef.current = null;
      for (const peer of Object.keys(pending)) delete pending[peer];
      setGossipStatus('Idle');
    };
  }, [gossipActive, transport, profile.deviceId, addLog]);

  // ── Bluetooth Actions ──────────────────────────────────

  useEffect(() => {
    getSyncLog().then(rows => setSyncLogCount(rows.length)).catch(() => {});
    return () => {
      bleRef.current?.stop();
      bleRef.current = null;
    };
  }, []);

  const startBluetooth = async () => {
    if (!profile.deviceId) return;
    setBleStarting(true);
    const ble = new BluetoothSync(profile.deviceId);
    ble.onLog = addLog;
    ble.onPeersChange = setBlePeers;
    ble.onMessage = message => {
      gossipRef.current?.receive(message);
    };
    try {
      await ble.start();
      bleRef.current = ble;
      setBleRunning(true);
    } catch (e: any) {
      addLog(`❌ Bluetooth: ${e?.message ?? e}`);
      await ble.stop();
    } finally {
      setBleStarting(false);
    }
  };

  const stopBluetooth = async () => {
    setBleRunning(false);
    await bleRef.current?.stop();
    bleRef.current = null;
    setBlePeers([]);
    addLog('🔌 Bluetooth sync stopped');
  };

  const switchTransport = async (next: 'ble' | 'relay') => {
    if (next === transport) return;
    if (transport === 'ble' && bleRunning) await stopBluetooth();
    if (transport === 'relay' && p2pStatus === 'connected') disconnectFromRelay();
    setTransport(next);
  };

  const exportSyncLog = async () => {
    try {
      const csv = await getSyncLogCsv();
      await Share.share({ message: csv, title: 'EquiStride sync log' });
    } catch (e: any) {
      addLog(`❌ Export failed: ${e?.message ?? e}`);
    }
  };

  const resetSyncLog = async () => {
    await clearSyncLog();
    setSyncLogCount(0);
    addLog('🧹 Sync log cleared');
  };

  // ── P2P Actions ────────────────────────────────────────

  const connectToRelay = async () => {
    if (!serverAddress.trim()) {
      addLog('❌ Please enter the relay server address (e.g. 192.168.1.5:8080)');
      return;
    }
    try {
      await p2pRef.current?.connect(serverAddress.trim(), profile.deviceId, profile.name);
    } catch (e: any) {
      addLog(`❌ Connection failed: ${e.message}`);
    }
  };

  const disconnectFromRelay = () => {
    p2pRef.current?.disconnect();
  };

  const broadcastToP2P = async () => {
    setIsSyncing(true);
    addLog('────────────────────────────────────');
    addLog('📢 Broadcasting local state to connected peers...');
    try {
      const payload = await createLocalPayload();
      const sent = p2pRef.current?.sendPayload(payload);
      if (!sent) {
        addLog('❌ Send failed — not connected to relay.');
      }
    } catch (e: any) {
      addLog(`❌ Broadcast failed: ${e.message}`);
    } finally {
      setIsSyncing(false);
    }
  };

  // ── Web BroadcastChannel Sync ──────────────────────────

  const performBroadcastSync = async () => {
    if (!broadcastChannel) {
      addLog('❌ BroadcastChannel API not available on this platform.');
      return;
    }
    setIsSyncing(true);
    addLog(`📢 Broadcasting local state vector to browser tabs...`);
    try {
      const payload = await createLocalPayload();
      broadcastChannel.postMessage({ type: 'SYNC_PAYLOAD', payload });
      const sizeBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
      addLog(`📤 Broadcast sent. Payload size: ${sizeBytes} bytes`);
    } catch (e) {
      addLog(`❌ Broadcast failed: ${e}`);
    } finally {
      setIsSyncing(false);
    }
  };

  // ── BLE Simulation (Mock) ──────────────────────────────

  const performBleSimulation = async (runnerName: keyof typeof MOCK_DEVICES) => {
    setIsSyncing(true);
    addLog(`------------------------------------`);
    addLog(`🔍 Scanning for BLE peers...`);

    setTimeout(() => {
      addLog(`📱 Found device: ${runnerName}-iPhone (RSSI: -62dBm)`);
      addLog(`🔗 Connecting to GATT Server...`);

      setTimeout(async () => {
        addLog(`✅ Connected! Exchanging CRDT State Vectors...`);

        const peerDeviceId = MOCK_DEVICES[runnerName];
        const runnerProfile = RUNNER_PROFILES.find(r => r.name === runnerName);

        const mockPayload: SyncPayload = {
          deviceId: peerDeviceId,
          timestamp: Date.now(),
          crdtState: { [peerDeviceId]: runnerProfile?.sessions.length || 0 },
          leaderboardEntries: runnerProfile ? [
            {
              id: `mock-entry-${runnerName}`,
              device_id: peerDeviceId,
              user_alias: runnerName,
              route_id: 'default-route',
              rii_score: runnerProfile.latestRII,
              npi_score: runnerProfile.npiScore,
              total_time_s: runnerProfile.sessions[0].totalTimeS,
              synced_at: Date.now(),
              created_at: Date.now() - 86400000,
              updated_at: Date.now() - 86400000,
            }
          ] : [],
          version: 1
        };

        const sizeBytes = new TextEncoder().encode(JSON.stringify(mockPayload)).length;
        if (sizeBytes > 512) {
          addLog(`⚠️ MTU WARNING: Payload ${sizeBytes}B exceeds BLE limits (512B)`);
        } else {
          addLog(`📦 Received payload: ${sizeBytes} bytes`);
        }

        await handleIncomingPayload(mockPayload);
        addLog(`🏁 BLE Sync Simulation Complete.`);
        setIsSyncing(false);

      }, 1000);
    }, 1000);
  };

  // ── Status Indicator ───────────────────────────────────

  const statusColor = p2pStatus === 'connected' ? C.accent
    : p2pStatus === 'connecting' ? C.amber
    : p2pStatus === 'error' ? C.red
    : C.separator;

  const statusLabel = p2pStatus === 'connected' ? `Connected (${peerCount} peer${peerCount !== 1 ? 's' : ''})`
    : p2pStatus === 'connecting' ? 'Connecting...'
    : p2pStatus === 'error' ? 'Connection Error'
    : 'Disconnected';

  // ── Render ─────────────────────────────────────────────

  return (
    <View style={styles.container}>
      {/* Header Card */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>P2P SYNCHRONIZATION</Text>
        <Text style={styles.desc}>
          Sync leaderboards directly between phones over Bluetooth, with no internet. The Wi-Fi relay is a fallback that needs a laptop on the same network.
        </Text>

        <View style={styles.segment}>
          {(['ble', 'relay'] as const).map(t => (
            <TouchableOpacity
              key={t}
              style={[styles.segmentItem, transport === t && styles.segmentItemActive, t === 'ble' && !bleAvailable && styles.buttonDisabled]}
              onPress={() => switchTransport(t)}
              disabled={t === 'ble' && !bleAvailable}
            >
              <Text style={[styles.segmentText, transport === t && styles.segmentTextActive]}>
                {t === 'ble' ? 'Bluetooth' : 'Wi-Fi relay'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        {!bleAvailable && (
          <Text style={styles.hint}>Bluetooth sync needs the Android development build.</Text>
        )}

        <View style={styles.identityBox}>
          <Text style={styles.identityLabel}>YOUR DEVICE ID</Text>
          <Text style={styles.identityValue}>{profile.deviceId || 'Loading...'}</Text>
          <Text style={styles.identityLabel}>ALIAS</Text>
          <Text style={styles.identityValue}>{profile.name}</Text>
        </View>
      </View>

      {/* Bluetooth Card */}
      {transport === 'ble' && (
        <View style={styles.card}>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: bleRunning ? C.accent : bleStarting ? C.amber : C.separator }]} />
            <Text style={[styles.statusText, { color: bleRunning ? C.accent : bleStarting ? C.amber : '#8E8E93' }]}>
              {bleRunning
                ? `Bluetooth on · ${blePeers.filter(p => p.status === 'connected').length} linked`
                : bleStarting ? 'Starting Bluetooth...' : 'Bluetooth off'}
            </Text>
          </View>

          {bleRunning && (
            <View style={styles.gossipBox}>
              <Text style={styles.identityLabel}>AUTO-SYNC (ANTI-ENTROPY GOSSIP · {GOSSIP_INTERVAL_MS / 1000} s)</Text>
              <Text style={styles.gossipStatus}>{gossipStatus}</Text>
            </View>
          )}

          {bleRunning && (
            <View style={{ marginBottom: 12 }}>
              <Text style={styles.identityLabel}>NEARBY RUNNERS</Text>
              {blePeers.length === 0 ? (
                <Text style={styles.hint}>Searching... keep the other phone close with the Sync tab open.</Text>
              ) : (
                blePeers.map((peer, i) => {
                  const name = peer.deviceId
                    ? peerAliasesRef.current[peer.deviceId] ?? syncedPeers.find(s => s.device_id === peer.deviceId)?.user_alias ?? peer.deviceId.substring(0, 12)
                    : `Runner ${peer.tag.substring(0, 6)}`;
                  const color = peer.status === 'connected' ? C.accent : peer.status === 'connecting' ? C.amber : peer.status === 'lost' ? C.red : C.blue;
                  return (
                    <View key={peer.tag} style={[styles.peerRow, i > 0 && styles.peerRowBorder]}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.peerName}>{name}</Text>
                        <Text style={styles.peerMeta}>
                          {peer.rssi !== null ? `${peer.rssi} dBm` : 'RSSI --'}
                          {peer.mtu ? ` · MTU ${peer.mtu}` : ''}
                          {peer.role ? ` · ${peer.role}` : ''}
                        </Text>
                      </View>
                      <Text style={[styles.peerStatus, { color }]}>{peer.status}</Text>
                    </View>
                  );
                })
              )}
            </View>
          )}

          <TouchableOpacity
            style={[styles.button, bleRunning ? styles.disconnectBtn : styles.connectBtn, bleStarting && styles.buttonDisabled]}
            onPress={bleRunning ? stopBluetooth : startBluetooth}
            disabled={bleStarting}
          >
            <Text style={styles.buttonText}>
              {bleRunning ? '🔌 Stop Bluetooth Sync' : bleStarting ? '⏳ Starting...' : '📶 Start Bluetooth Sync'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Wi-Fi Relay Card */}
      {transport === 'relay' && (
      <View style={styles.card}>
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
        </View>

        {p2pStatus !== 'connected' ? (
          <>
            <Text style={styles.inputLabel}>RELAY SERVER ADDRESS</Text>
            <TextInput
              style={styles.input}
              value={serverAddress}
              onChangeText={setServerAddress}
              placeholder="172.20.10.4:8080"
              placeholderTextColor="#8E8E93"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              selectionColor="#00FF87"
            />
            <TouchableOpacity
              style={[styles.button, styles.connectBtn, p2pStatus === 'connecting' && styles.buttonDisabled]}
              onPress={connectToRelay}
              disabled={p2pStatus === 'connecting'}
            >
              <Text style={styles.buttonText}>
                {p2pStatus === 'connecting' ? '⏳ Connecting...' : '🔗 Connect to Relay'}
              </Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <View style={styles.gossipBox}>
              <Text style={styles.identityLabel}>AUTO-SYNC (ANTI-ENTROPY GOSSIP · {GOSSIP_INTERVAL_MS / 1000} s)</Text>
              <Text style={styles.gossipStatus}>{gossipStatus}</Text>
            </View>
            <TouchableOpacity
              style={[styles.button, styles.syncBtn, isSyncing && styles.buttonDisabled]}
              onPress={broadcastToP2P}
              disabled={isSyncing}
            >
              <Text style={styles.buttonText}>📡 Broadcast Sync to Peers</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.disconnectBtn]}
              onPress={disconnectFromRelay}
            >
              <Text style={styles.buttonText}>🔌 Disconnect</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
      )}

      {/* Sync measurements (thesis ST-03): one row per completed sync */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>SYNC LOG</Text>
        <Text style={styles.hint}>
          {syncLogCount} sync{syncLogCount === 1 ? '' : 's'} recorded (time to sync, bytes, frames, MTU, RSSI).
        </Text>
        <View style={styles.peerButtons}>
          <TouchableOpacity style={[styles.button, styles.peerBtn]} onPress={exportSyncLog}>
            <Text style={styles.buttonText}>Export CSV</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.button, styles.peerBtn]} onPress={resetSyncLog}>
            <Text style={styles.buttonText}>Clear</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Fallback Sync Options */}
      <View style={styles.actionsContainer}>
        {Platform.OS === 'web' && (
          <TouchableOpacity
            style={[styles.button, styles.broadcastBtn, isSyncing && styles.buttonDisabled]}
            onPress={performBroadcastSync}
            disabled={isSyncing}
          >
            <Text style={styles.buttonText}>🌐 Browser Tab Sync</Text>
          </TouchableOpacity>
        )}

        <Text style={styles.simulatorLabel}>DEMO DATA (SAMPLE RUNNERS, NOT REAL PEERS)</Text>
        <View style={styles.peerButtons}>
          {(Object.keys(MOCK_DEVICES) as Array<keyof typeof MOCK_DEVICES>).map(name => (
            <TouchableOpacity
              key={name}
              style={[styles.button, styles.peerBtn, isSyncing && styles.buttonDisabled]}
              onPress={() => performBleSimulation(name)}
              disabled={isSyncing}
            >
              <Text style={styles.buttonText}>Sync {name}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Synced Peers */}
      {syncedPeers.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>RECENTLY SYNCED PEERS</Text>
          <Text style={styles.desc}>
            Compare your RII and NPI against peers you've synced with.
          </Text>
          {syncedPeers.map((peer, i) => (
            <View key={peer.id} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderTopWidth: i > 0 ? 1 : 0, borderTopColor: C.separator }}>
              <View>
                <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '600' }}>{peer.user_alias}</Text>
                <Text style={{ color: '#8E8E93', fontSize: 12 }}>Device: {peer.device_id.substring(0, 8)}...</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ color: C.accent, fontSize: 14, fontWeight: '700' }}>RII {peer.rii_score.toFixed(2)}</Text>
                <Text style={{ color: '#BF5AF2', fontSize: 12, fontWeight: '600' }}>NPI {peer.npi_score ? peer.npi_score.toFixed(2) : '0.00'}</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Console Log */}
      <View style={styles.consoleContainer}>
        <View style={styles.consoleHeader}>
          <Text style={styles.consoleTitle}>SYNC LOGS</Text>
          <TouchableOpacity onPress={() => setLogs([])}>
            <Text style={styles.clearText}>Clear</Text>
          </TouchableOpacity>
        </View>
        <ScrollView style={styles.consoleScroll} contentContainerStyle={styles.consoleContent}>
          {logs.length === 0 ? (
            <Text style={styles.logTextEmpty}>Waiting for sync events...</Text>
          ) : (
            logs.map((log, i) => (
              <Text key={i} style={styles.logText}>{log}</Text>
            ))
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  card: {
    backgroundColor: C.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: C.separator,
  },
  sectionTitle: { color: C.accent, fontSize: 13, fontWeight: '700', letterSpacing: 1, marginBottom: 8 },
  desc: { color: '#8E8E93', fontSize: 14, lineHeight: 20, marginBottom: 16 },
  identityBox: { backgroundColor: C.surfaceElevated, padding: 12, borderRadius: 8 },
  identityLabel: { color: '#8E8E93', fontSize: 11, fontWeight: '600', letterSpacing: 0.5, marginBottom: 4 },
  identityValue: { color: '#FFFFFF', fontSize: 14, fontWeight: '500', marginBottom: 12 },

  // Status
  statusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  statusDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  statusText: { fontSize: 14, fontWeight: '600' },
  gossipBox: { backgroundColor: C.surfaceElevated, padding: 12, borderRadius: 8, marginBottom: 12 },

  // Transport selector + Bluetooth peers
  segment: { flexDirection: 'row', backgroundColor: C.surfaceElevated, borderRadius: 10, padding: 3, marginTop: 12 },
  segmentItem: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center' },
  segmentItemActive: { backgroundColor: C.accentDim },
  segmentText: { color: '#8E8E93', fontSize: 14, fontWeight: '600' },
  segmentTextActive: { color: C.accent },
  hint: { color: '#8E8E93', fontSize: 12, lineHeight: 17, marginTop: 6, marginBottom: 8 },
  peerRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  peerRowBorder: { borderTopWidth: 1, borderTopColor: C.separator },
  peerName: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  peerMeta: { color: '#8E8E93', fontSize: 12, marginTop: 2 },
  peerStatus: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  gossipStatus: { color: C.teal, fontSize: 14, fontWeight: '600' },

  // Input
  inputLabel: { color: '#8E8E93', fontSize: 11, fontWeight: '600', letterSpacing: 0.5, marginBottom: 6 },
  input: {
    backgroundColor: C.surfaceElevated,
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: C.accent,
    marginBottom: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } as any : {}),
  },

  // Buttons
  actionsContainer: { marginBottom: 12 },
  simulatorLabel: { color: '#8E8E93', fontSize: 12, fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, marginTop: 4 },
  button: { paddingVertical: 14, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  connectBtn: { backgroundColor: C.blue },
  syncBtn: { backgroundColor: C.accent },
  disconnectBtn: { backgroundColor: C.red },
  broadcastBtn: { backgroundColor: C.blue },
  peerButtons: { flexDirection: 'row', gap: 8 },
  peerBtn: { backgroundColor: '#38383A', flex: 1 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },

  // Console
  consoleContainer: { flex: 1, backgroundColor: '#000000', borderRadius: 12, borderWidth: 1, borderColor: '#38383A', overflow: 'hidden' },
  consoleHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#1C1C1E', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#38383A' },
  consoleTitle: { color: '#8E8E93', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  clearText: { color: C.accent, fontSize: 13, fontWeight: '500' },
  consoleScroll: { flex: 1, padding: 12 },
  consoleContent: { paddingBottom: 20 },
  logText: { color: '#00FF00', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, marginBottom: 6, lineHeight: 16 },
  logTextEmpty: { color: '#8E8E93', fontStyle: 'italic', fontSize: 12 },
});
