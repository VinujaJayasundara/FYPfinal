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
  invite: (deviceId: string) => void;
  accept: (deviceId: string) => void;
  unpair: (deviceId: string) => void;
  setMessageHandler: (fn: ((m: GossipMessage) => void) | null) => void;
  addLogListener: (fn: (msg: string) => void) => () => void;
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

  const log = useCallback((msg: string) => {
    logListenersRef.current.forEach(fn => fn(msg));
  }, []);

  // One BleManager for the app: watches whether Bluetooth is on
  useEffect(() => {
    if (!available) return;
    const manager = new BleManager();
    managerRef.current = manager;
    const sub = manager.onStateChange(state => setAdapterOn(state === State.PoweredOn), true);
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
    service.onPeersChange = setPeers;
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
  }, [available, profile.deviceId, profile.name, log]);

  // Keep the name peers see in sync with the profile
  useEffect(() => {
    bleRef.current?.setAlias(profile.name);
  }, [profile.name]);

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
      invite: id => {
        bleRef.current?.invite(id);
      },
      accept: id => {
        bleRef.current?.accept(id);
      },
      unpair: id => bleRef.current?.unpair(id),
      setMessageHandler: fn => {
        messageHandlerRef.current = fn;
      },
      addLogListener: fn => {
        logListenersRef.current.add(fn);
        return () => {
          logListenersRef.current.delete(fn);
        };
      },
    }),
    [available, adapterOn, ble, starting, peers, gossipStatus, start, stop],
  );

  return <BluetoothContext.Provider value={value}>{children}</BluetoothContext.Provider>;
}

export function useBluetooth(): BluetoothContextValue {
  const ctx = useContext(BluetoothContext);
  if (!ctx) throw new Error('useBluetooth must be used inside BluetoothProvider');
  return ctx;
}
