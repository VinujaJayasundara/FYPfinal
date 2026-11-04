/**
 * Notes which friends a run was done with, for the history (peer runs are
 * shown in a different colour and can be filtered).
 *
 * A friend counts when they were paired (accepted on both sides) at any
 * moment during the run, or when the run was a connected race. Only their
 * node ID and name are stored — no location. Renders nothing; lives inside
 * the Bluetooth and Race providers.
 */

import { useEffect, useRef } from 'react';
import { useRun } from '../context/RunContext';
import { useBluetooth } from '../context/BluetoothContext';
import { useRace } from '../context/RaceContext';
import { addRunPeers } from '../data/database';
import type { RunPeer } from '../../../GhostTracker/src/core/history/runHistory';

export default function RunPeerTracker() {
  const { run, incrementDbVersion } = useRun();
  const bt = useBluetooth();
  const { race } = useRace();
  const seenRef = useRef(new Map<string, RunPeer>());
  const runStartRef = useRef<number | null>(null);

  // New run: start a fresh list
  useEffect(() => {
    if (run.status === 'running' && run.startTime && runStartRef.current !== run.startTime) {
      runStartRef.current = run.startTime;
      seenRef.current = new Map();
    }
  }, [run.status, run.startTime]);

  // While running: everyone paired, and the race friend
  useEffect(() => {
    if (run.status !== 'running') return;
    for (const p of bt.peers) {
      if (p.deviceId && p.pairing === 'paired' && !seenRef.current.has(p.deviceId)) {
        seenRef.current.set(p.deviceId, { peerId: p.deviceId, alias: p.alias ?? 'Friend', kind: 'connected' });
      }
    }
    if (race && race.phase !== 'cancelled' && race.me.status !== 'not-started') {
      seenRef.current.set(race.friendId, { peerId: race.friendId, alias: race.friendAlias, kind: 'race' });
    }
  }, [run.status, bt.peers, race]);

  // Run ended: save the list against the run's start time
  useEffect(() => {
    if (run.status !== 'finished' || !run.startTime || runStartRef.current !== run.startTime) return;
    const peers = [...seenRef.current.values()];
    runStartRef.current = null;
    if (peers.length === 0) return;
    addRunPeers(run.startTime, peers)
      .then(() => incrementDbVersion())
      .catch(e => console.warn('[RunPeers] Could not save:', e));
  }, [run.status, run.startTime, incrementDbVersion]);

  return null;
}
