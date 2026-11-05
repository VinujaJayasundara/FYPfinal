/**
 * BluetoothContext — one Bluetooth sync service for the whole app.
 *
 * Owns the single BleManager (adapter on/off state) and the BluetoothSync
 * transport, so the Run screen ("Connect with a friend") and the Sync tab
 * share the same links. Invitations from nearby runners pop up as an
 * Accept / Decline dialog on whatever screen is open.
 *
 * The gossip session itself stays in the Sync tab (always mounted); it
 * registers a message handler here and reports its status back.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Alert } from 'react-native';
import { BleManager, State } from 'react-native-ble-plx';
import { BluetoothSync, BlePeer } from '../core/BluetoothSync';
import type { GossipMessage } from '../../../GhostTracker/src/core/crdt';
import { useProfile } from './ProfileContext';
import { upsertPeer } from '../data/database';

interface BluetoothContextValue {
  /** Android development build with the BLE peripheral module. */
  available: boolean;
  /** Phone's Bluetooth adapter is on (null = unknown yet). */
  adapterOn: boolean | null;
  running: boolean;
  starting: boolean;
  peers: BlePeer[];
  /** The live transport while running (for the gossip session). */
  ble: BluetoothSync | null;
  /** Latest gossip status text from the Sync tab. */
  gossipStatus: string;
  setGossipStatus: (s: string) => void;
  start: () => Promise<boolean>;
  stop: () => Promise<void>;
  /**
   * Before connecting: asks for the Nearby-devices permission if needed and
   * checks that Bluetooth is on. 'ok' | 'denied' (permission refused) | 'off'.
   */
  prepare: () => Promise<'ok' | 'denied' | 'off'>;
  invite: (deviceId: string) => void;
  accept: (deviceId: string) => void;
  unpair: (deviceId: string) => void;
  setMessageHandler: (fn: ((m: GossipMessage) => void) | null) => void;
  addLogListener: (fn: (msg: string) => void) => () => void;
  /** Race messages to / from a paired runner. */
  sendRace: (deviceId: string, payload: unknown) => boolean;
  addRaceListener: (fn: (deviceId: string, payload: unknown) => void) => () => void;
  /** Pairing changes (paired or ended) for the race to react to. */
  addPairingListener: (fn: (deviceId: string, paired: boolean) => void) => () => void;
}

const BluetoothContext = createContext<BluetoothContextValue | null>(null);

export function BluetoothProvider({ children }: { children: ReactNode }) {
  const { profile } = useProfile();
  const available = BluetoothSync.isAvailable();

  const managerRef = useRef<BleManager | null>(null);
  const [adapterOn, setAdapterOn] = useState<boolean | null>(null);
  const [ble, setBle] = useState<BluetoothSync | null>(null);
  const bleRef = useRef<BluetoothSync | null>(null);
  const [starting, setStarting] = useState(false);
  const [peers, setPeers] = useState<BlePeer[]>([]);
  const [gossipStatus, setGossipStatus] = useState('Idle');

  const messageHandlerRef = useRef<((m: GossipMessage) => void) | null>(null);
  const logListenersRef = useRef(new Set<(msg: string) => void>());
  const raceListenersRef = useRef(new Set<(deviceId: string, payload: unknown) => void>());
  const pairingListenersRef = useRef(new Set<(deviceId: string, paired: boolean) => void>());

  const log = useCallback((msg: string) => {
    logListenersRef.current.forEach(fn => fn(msg));
  }, []);

  // p2p_peers (thesis Table 15): one row per identified peer. Scanning updates
  // arrive several times a second, so a row is written only when the peer's
  // status changes or at most every 10 s.
  const peerWritesRef = useRef(new Map<string, { status: string; at: number }>());
  const recordPeers = useCallback((list: BlePeer[]) => {
    const now = Date.now();
    for (const p of list) {
      if (!p.deviceId) continue; // not identified yet (no hello)
      const status = p.pairing ?? p.status;
      const last = peerWritesRef.current.get(p.deviceId);
      if (last && last.status === status && now - last.at < 10_000) continue;
      peerWritesRef.current.set(p.deviceId, { status, at: now });
      upsertPeer({
        peer_id: p.deviceId,
        mac_address: p.address,
        rssi: p.rssi,
        mtu_size: p.mtu,
        status,
        alias: p.alias,
        last_seen: p.lastSeen,
      }).catch(e => console.warn('[BLE] Could not record peer:', e));
    }
  }, []);

  // One BleManager for the app: watches whether Bluetooth is on
  useEffect(() => {
    if (!available) return;
    const manager = new BleManager();
    managerRef.current = manager;
    // Read the current state ourselves so a failure (e.g. before the
    // Bluetooth permission is granted) is handled instead of becoming an
    // unhandled promise rejection inside the library.
    const sub = manager.onStateChange(state => setAdapterOn(state === State.PoweredOn), false);
    manager
      .state()
      .then(state => setAdapterOn(state === State.PoweredOn))
      .catch(() => setAdapterOn(null));
    return () => {
      sub.remove();
      bleRef.current?.stop();
      bleRef.current = null;
      manager.destroy();
      managerRef.current = null;
    };
  }, [available]);

  const stop = useCallback(async () => {
    const current = bleRef.current;
    bleRef.current = null;
    setBle(null);
    setPeers([]);
    if (current) {
      await current.stop();
      log('🔌 Bluetooth sync stopped');
    }
  }, [log]);

  const prepare = useCallback(async (): Promise<'ok' | 'denied' | 'off'> => {
    if (!(await BluetoothSync.ensurePermissions())) return 'denied';
    const manager = managerRef.current;
    if (!manager) return 'off';
    // Without the permission the adapter state could not be read before; read it now
    const state = await manager.state().catch(() => null);
    const on = state === State.PoweredOn;
    setAdapterOn(on);
    return on ? 'ok' : 'off';
  }, []);

  // Bluetooth switched off while running: tear the service down
  useEffect(() => {
    if (adapterOn === false && bleRef.current) stop();
  }, [adapterOn, stop]);

  const start = useCallback(async (): Promise<boolean> => {
    if (bleRef.current) return true;
    if (!available || !profile.deviceId || !managerRef.current) return false;
    setStarting(true);
    const service = new BluetoothSync(profile.deviceId, profile.name, managerRef.current);
    service.onLog = log;
    service.onPeersChange = list => {
      setPeers(list);
      recordPeers(list);
    };
    service.onMessage = m => messageHandlerRef.current?.(m);
    service.onInvite = (deviceId, alias) => {
      Alert.alert(
        'Sync invitation',
        `${alias} wants to connect and share leaderboards with you.`,
        [
          { text: 'Decline', style: 'cancel', onPress: () => service.decline(deviceId) },
          { text: 'Accept', onPress: () => service.accept(deviceId) },
        ],
        { cancelable: false },
      );
    };
    service.onRace = (deviceId, payload) => {
      raceListenersRef.current.forEach(fn => fn(deviceId, payload));
    };
    service.onPairingChange = (deviceId, _alias, pairing) => {
      pairingListenersRef.current.forEach(fn => fn(deviceId, pairing === 'paired'));
    };
    service.onDecline = (_deviceId, alias) => {
      Alert.alert('Invitation declined', `${alias} declined your invitation.`);
    };
    try {
      await service.start();
      bleRef.current = service;
      setBle(service);
      return true;
    } catch (e: any) {
      log(`❌ Bluetooth: ${e?.message ?? e}`);
      await service.stop();
      Alert.alert('Bluetooth', e?.message ?? String(e));
      return false;
    } finally {
      setStarting(false);
    }
  }, [available, profile.deviceId, profile.name, log, recordPeers]);

  // Keep the name peers see in sync with the profile
  useEffect(() => {
    bleRef.current?.setAlias(profile.name);
  }, [profile.name]);

  // Functions that only go through refs: created once, so consumers' effects
  // (gossip handler, race timer) are not reset by peer-list updates, which
  // arrive several times a second while scanning.
  const stable = useMemo(
    () => ({
      invite: (id: string) => {
        bleRef.current?.invite(id);
      },
      accept: (id: string) => {
        bleRef.current?.accept(id);
      },
      unpair: (id: string) => bleRef.current?.unpair(id),
      setMessageHandler: (fn: ((m: GossipMessage) => void) | null) => {
        messageHandlerRef.current = fn;
      },
      addLogListener: (fn: (msg: string) => void) => {
        logListenersRef.current.add(fn);
        return () => {
          logListenersRef.current.delete(fn);
        };
      },
      sendRace: (id: string, payload: unknown) => bleRef.current?.sendRace(id, payload) ?? false,
      addRaceListener: (fn: (deviceId: string, payload: unknown) => void) => {
        raceListenersRef.current.add(fn);
        return () => {
          raceListenersRef.current.delete(fn);
        };
      },
      addPairingListener: (fn: (deviceId: string, paired: boolean) => void) => {
        pairingListenersRef.current.add(fn);
        return () => {
          pairingListenersRef.current.delete(fn);
        };
      },
    }),
    [],
  );

  const value = useMemo<BluetoothContextValue>(
    () => ({
      available,
      adapterOn,
      running: ble !== null,
      starting,
      peers,
      ble,
      gossipStatus,
      setGossipStatus,
      start,
      stop,
      prepare,
      ...stable,
    }),
    [available, adapterOn, ble, starting, peers, gossipStatus, start, stop, prepare, stable],
  );

  return <BluetoothContext.Provider value={value}>{children}</BluetoothContext.Provider>;
}

export function useBluetooth(): BluetoothContextValue {
  const ctx = useContext(BluetoothContext);
  if (!ctx) throw new Error('useBluetooth must be used inside BluetoothProvider');
  return ctx;
}
