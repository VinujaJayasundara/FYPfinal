/**
 * RunScreen — Run Tracking UI (Presentation Only)
 * ==================================================
 * All run state, GPS subscription, and timer management have been moved
 * to RunContext.  This screen is now a pure presentation layer that reads
 * from the context via useRun() and renders one of three views:
 *   - IdleView        — map preview + "Start" button
 *   - RunningView     — live map, stats, stop button
 *   - FinishedView    — run summary, route map, reset button
 *
 * Competition Mode:
 *   When synced with a peer via the relay, both runners' positions appear
 *   on the map and a live NPI comparison overlay is shown.
 */

import React, { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Dimensions,
  ScrollView,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Keyboard,
  TouchableWithoutFeedback,
  StatusBar,
} from 'react-native';
import {
  haversineDistanceM,
  formatPace,
  formatTime,
  calculateRII,
  getRIIStatus,
} from '../core/algorithms';
import { useRun, type GPSPoint, type RunState } from '../context/RunContext';
import { useProfile } from '../context/ProfileContext';
import { FriendConnectButton } from '../components/FriendConnect';
import { RaceSetupCard, RaceLiveCard, RaceStrip } from '../components/RaceUI';
import { useRace, RACE_COLOR, RACE_ME_COLOR, RACE_FRIEND_COLOR } from '../context/RaceContext';
import { P2PSyncService, LivePosition, type P2PStatus } from '../core/p2pSync';
import { calculateNPI, formatNPI, getNPIStatus } from '../core/npiEngine';
import { ghostDistanceAtTime } from '../../../GhostTracker/src/core/fairness/ghostComparator';

import {
  IdleMap,
  RunningMap,
  FinishedMap,
  animateMapToRegion,
  fitMapToCoordinates,
} from '../components/RunMap';
import OfflineMapButton from '../components/OfflineMapButton';
import RunScores from '../components/RunScores';
import { Button, Card, Icon, IconButton, IconCircle, T, glassFill } from '../components/ui';
import { colors, fonts, radius, space } from '../theme/tokens';
import { CALIBRATION_RUNS } from '../../../GhostTracker/src/core/fairness/calibration';
import { SOLO_COLOR } from '../theme/runColors';

/** Development only: the old Wi-Fi relay sync (before Bluetooth). Off. */
const SHOW_RELAY_SYNC = false;

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const MAP_HEIGHT = SCREEN_HEIGHT * 0.45;

// ── Ghost position helper (interpolate along route) ───────

function getPositionAlongRoute(
  points: { latitude: number; longitude: number }[],
  targetDistM: number,
): { latitude: number; longitude: number } | null {
  if (points.length === 0) return null;
  if (points.length === 1 || targetDistM <= 0) return points[0];

  let accumulated = 0;
  for (let i = 1; i < points.length; i++) {
    const segDist = haversineDistanceM(
      points[i - 1].latitude,
      points[i - 1].longitude,
      points[i].latitude,
      points[i].longitude,
    );
    if (accumulated + segDist >= targetDistM) {
      const fraction = segDist > 0 ? (targetDistM - accumulated) / segDist : 0;
      return {
        latitude:
          points[i - 1].latitude +
          fraction * (points[i].latitude - points[i - 1].latitude),
        longitude:
          points[i - 1].longitude +
          fraction * (points[i].longitude - points[i - 1].longitude),
      };
    }
    accumulated += segDist;
  }
  return points[points.length - 1];
}

// ── Main Component ────────────────────────────────────────

export default function RunScreen() {
  const { run, initialLocation, startRun, stopRun, resetRun } = useRun();
  const { profile } = useProfile();
  const mapRef = useRef<any>(null);

  // ── P2P Competition State ─────────────────────────────
  const p2pRef = useRef<P2PSyncService | null>(null);
  const [p2pStatus, setP2PStatus] = useState<P2PStatus>('disconnected');
  const [peerCount, setPeerCount] = useState(0);
  const [peerPosition, setPeerPosition] = useState<LivePosition | null>(null);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [serverAddress, setServerAddress] = useState('172.20.10.4:8080');
  const [connectedPeerAlias, setConnectedPeerAlias] = useState<string | null>(null);
  const [discoveredPeers, setDiscoveredPeers] = useState<{ deviceId: string; alias: string }[]>([]);

  // Initialize P2P service once
  useEffect(() => {
    const service = new P2PSyncService();
    service.onStatusChange = (s) => setP2PStatus(s);
    service.onPeerCountChange = (c) => setPeerCount(c);
    service.onPeerJoined = (peer) => {
      setConnectedPeerAlias(peer.alias);
      setDiscoveredPeers((prev) => {
        if (prev.some((p) => p.deviceId === peer.deviceId)) return prev;
        return [...prev, { deviceId: peer.deviceId, alias: peer.alias }];
      });
    };
    service.onPeerLeft = (peer) => {
      setDiscoveredPeers((prev) => prev.filter((p) => p.deviceId !== peer.deviceId));
      setConnectedPeerAlias(null);
      setPeerPosition(null);
    };
    service.onPeerListReceived = (peers) => {
      setDiscoveredPeers(peers);
      if (peers.length > 0) setConnectedPeerAlias(peers[0].alias);
    };
    service.onLivePositionReceived = (pos) => setPeerPosition(pos);
    p2pRef.current = service;
    return () => { service.disconnect(); };
  }, []);

  // Broadcast own race stats (no coordinates) every 2s during a run when connected
  useEffect(() => {
    if (run.status !== 'running' || p2pStatus !== 'connected') return;
    const interval = setInterval(() => {
      if (run.validPoints.length === 0 || !p2pRef.current) return;

      // Calculate live NPI
      let npi: number | null = null;
      if (run.avgPaceSPerKm > 0 && isFinite(run.avgPaceSPerKm) && profile.age > 0) {
        const result = calculateNPI(
          { age: profile.age, weightKg: profile.weightKg, heightCm: profile.heightCm, bmi: profile.bmi, gender: profile.gender },
          { altitudeM: run.currentAltitudeM ?? 15, distanceM: run.distanceM, avgPaceSPerKm: run.avgPaceSPerKm },
        );
        npi = result.npi;
      }

      p2pRef.current.broadcastPosition({
        deviceId: profile.deviceId,
        alias: profile.name,
        distanceM: run.distanceM,
        elapsedS: run.elapsedS,
        avgPaceSPerKm: run.avgPaceSPerKm,
        currentPaceSPerKm: run.currentPaceSPerKm,
        npiScore: npi,
        timestamp: Date.now(),
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [run.status, p2pStatus, run.validPoints.length, run.distanceM, run.elapsedS]);

  // ── P2P Actions ────────────────────────────────────────
  const connectToRelay = useCallback(async () => {
    if (!serverAddress.trim()) return;
    try {
      await p2pRef.current?.connect(serverAddress.trim(), profile.deviceId, profile.name);
    } catch {}
  }, [serverAddress, profile.deviceId, profile.name]);

  const disconnectRelay = useCallback(() => {
    p2pRef.current?.disconnect();
    setConnectedPeerAlias(null);
    setPeerPosition(null);
    setDiscoveredPeers([]);
  }, []);

  // Common competition props
  const competitionProps = {
    p2pStatus,
    peerCount,
    peerPosition,
    connectedPeerAlias,
    discoveredPeers,
    showSyncModal,
    setShowSyncModal,
    serverAddress,
    setServerAddress,
    connectToRelay,
    disconnectRelay,
  };

  if (run.status === 'idle') {
    return <IdleView onStart={startRun} initialLocation={initialLocation} competition={competitionProps} />;
  }

  if (run.status === 'finished') {
    return <FinishedView run={run} onReset={resetRun} />;
  }

  return <RunningView run={run} onStop={stopRun} mapRef={mapRef} competition={competitionProps} profile={profile} />;
}

// ── Competition Props Type ────────────────────────────────

interface CompetitionProps {
  p2pStatus: P2PStatus;
  peerCount: number;
  peerPosition: LivePosition | null;
  connectedPeerAlias: string | null;
  discoveredPeers: { deviceId: string; alias: string }[];
  showSyncModal: boolean;
  setShowSyncModal: (v: boolean) => void;
  serverAddress: string;
  setServerAddress: (v: string) => void;
  connectToRelay: () => Promise<void>;
  disconnectRelay: () => void;
}

// ═══════════════════════════════════════════════════════════
// IDLE VIEW — Map preview + "Press to Start" + Sync Button
// ═══════════════════════════════════════════════════════════

function IdleView({
  onStart,
  initialLocation,
  competition,
}: {
  onStart: () => void;
  initialLocation: { latitude: number; longitude: number } | null;
  competition: CompetitionProps;
}) {
  const region = initialLocation
    ? {
        latitude: initialLocation.latitude,
        longitude: initialLocation.longitude,
        latitudeDelta: 0.005,
        longitudeDelta: 0.005,
      }
    : {
        // Default to Bellanwila Park area
        latitude: 6.8448,
        longitude: 79.8999,
        latitudeDelta: 0.005,
        longitudeDelta: 0.005,
      };

  const isConnected = competition.p2pStatus === 'connected';
  const syncDotColor = isConnected ? colors.accent : colors.border;
  const { race: raceState } = useRace();
  const race = raceState && raceState.phase !== 'cancelled' && raceState.phase !== 'done' ? raceState : null;

  return (
    <View style={styles.idleContainer}>
      {/* Map: your surroundings, full screen */}
      <View style={StyleSheet.absoluteFill}>
        <IdleMap region={region} />
      </View>

      {/* Top card: what kind of run, GPS state */}
      <View style={styles.preTop}>
        <Card tone="overlay" style={styles.preTopCard}>
          <IconCircle size={44} color={race ? colors.peer : colors.accent}>
            <Icon name={race ? 'link' : 'walk-outline'} size={22} color={colors.onAccent} />
          </IconCircle>
          <View style={{ flex: 1 }}>
            <T variant="title" numberOfLines={1}>
              {race ? `Race · ${race.targetM / 1000} km` : 'Solo run'}
            </T>
            <T variant="label" numberOfLines={1}>
              {race ? `vs ${race.friendAlias}` : initialLocation ? 'GPS locked · ready' : 'Finding GPS…'}
            </T>
          </View>
        </Card>
      </View>

      {/* Old Wi-Fi relay SYNC chip: hidden; "Connect with a friend" replaces it */}
      {SHOW_RELAY_SYNC && <TouchableOpacity
        style={[styles.syncButton, isConnected && styles.syncButtonConnected]}
        onPress={() => competition.setShowSyncModal(true)}
      >
        <View style={[styles.syncDot, { backgroundColor: syncDotColor }]} />
        <Text style={[styles.syncButtonText, isConnected && { color: colors.accent }]}>
          {isConnected ? `${competition.connectedPeerAlias || 'Peer'}` : 'SYNC'}
        </Text>
      </TouchableOpacity>}

      {/* Bottom panel: race / friend, GPS + offline map, START */}
      <ScrollView
        style={styles.preScroll}
        contentContainerStyle={styles.preBottom}
        showsVerticalScrollIndicator={false}
      >
        <RaceSetupCard />
        <FriendConnectButton />
        <View style={styles.preRow}>
          <Card tone="overlay" style={styles.preStatus}>
            <View style={styles.preStatusLine}>
              <View style={[styles.gpsDot, { backgroundColor: initialLocation ? colors.accent : colors.warn }]} />
              <T variant="body" style={{ fontFamily: fonts.semibold }}>
                {initialLocation ? 'GPS locked' : 'Finding GPS…'}
              </T>
            </View>
            <T variant="caption" style={{ marginBottom: space.sm }}>
              {initialLocation ? '1 Hz · filtered and smoothed' : 'Best outdoors; can take a minute'}
            </T>
            <OfflineMapButton location={initialLocation} inline />
          </Card>
          <Button label="Start" icon="play" onPress={onStart} accessibilityLabel="Start run" style={styles.preStart} />
        </View>
      </ScrollView>

      {/* ── Peer Discovery Modal ───────────────────────── */}
      <Modal
        visible={competition.showSyncModal}
        transparent
        animationType="slide"
        onRequestClose={() => competition.setShowSyncModal(false)}
      >
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={styles.modalOverlay}
          >
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>P2P COMPETITION</Text>
                <TouchableOpacity onPress={() => competition.setShowSyncModal(false)}>
                  <Text style={styles.modalClose}>✕</Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.modalDesc}>
                Connect to a relay server to race a friend.{'\n'}
                Both phones must be on the same Wi-Fi network.
              </Text>

              {competition.p2pStatus !== 'connected' ? (
                <>
                  <Text style={styles.modalInputLabel}>RELAY SERVER ADDRESS</Text>
                  <TextInput
                    style={styles.modalInput}
                    value={competition.serverAddress}
                    onChangeText={competition.setServerAddress}
                    placeholder="172.20.10.4:8080"
                    placeholderTextColor={colors.textDim}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    selectionColor={colors.accent}
                  />
                  <TouchableOpacity
                    style={[styles.modalConnectBtn, competition.p2pStatus === 'connecting' && { opacity: 0.5 }]}
                    onPress={() => {
                      Keyboard.dismiss();
                      competition.connectToRelay();
                    }}
                    disabled={competition.p2pStatus === 'connecting'}
                  >
                    <Text style={styles.modalConnectBtnText}>
                      {competition.p2pStatus === 'connecting' ? 'Connecting…' : 'Connect to relay'}
                    </Text>
                  </TouchableOpacity>
                  {competition.p2pStatus === 'error' && (
                    <Text style={styles.modalError}>Connection failed. Check address and try again.</Text>
                  )}
                </>
              ) : (
                <>
                  <Text style={styles.nearbyTitle}>NEARBY DEVICES</Text>

                  {competition.discoveredPeers.length === 0 ? (
                    <View style={styles.scanningBox}>
                      <Text style={styles.scanningDots}>● ● ●</Text>
                      <Text style={styles.scanningText}>Scanning for nearby runners...</Text>
                      <Text style={styles.scanningHint}>
                        Ask your friend to connect to the same relay server
                      </Text>
                    </View>
                  ) : (
                    competition.discoveredPeers.map((peer) => (
                      <View key={peer.deviceId} style={styles.peerCard}>
                        <View style={styles.peerCardDot} />
                        <View style={styles.peerCardInfo}>
                          <Text style={styles.peerCardName}>{peer.alias}</Text>
                          <Text style={styles.peerCardStatus}>Connected · Ready to race</Text>
                        </View>
                      </View>
                    ))
                  )}

                  {competition.discoveredPeers.length > 0 && (
                    <TouchableOpacity
                      style={styles.modalStartRaceBtn}
                      onPress={() => {
                        competition.setShowSyncModal(false);
                        onStart();
                      }}
                    >
                      <Text style={styles.modalStartRaceBtnText}>START RACE</Text>
                    </TouchableOpacity>
                  )}

                  <TouchableOpacity style={styles.modalDisconnectBtn} onPress={competition.disconnectRelay}>
                    <Text style={styles.modalDisconnectBtnText}>Disconnect</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </KeyboardAvoidingView>
        </TouchableWithoutFeedback>
      </Modal>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════
// RUNNING VIEW — Live Map + Stats
// ═══════════════════════════════════════════════════════════

function RunningView({
  run,
  onStop,
  mapRef,
  competition,
  profile,
}: {
  run: RunState;
  onStop: () => void;
  mapRef: React.MutableRefObject<any>;
  competition: CompetitionProps;
  profile: { age: number; weightKg: number; heightCm: number; bmi: number; gender: 'M' | 'F'; name: string };
}) {
  const [followCamera, setFollowCamera] = useState(true);

  // Connected race: me blue, purple route. The friend's position is never
  // shared (only distance/time), so there is no friend pin on the map.
  const { race } = useRace();
  const inRace = race !== null && race.phase !== 'cancelled' && race.me.status !== 'not-started';
  const raceColors = inRace ? { me: RACE_ME_COLOR, friend: RACE_FRIEND_COLOR, route: RACE_COLOR } : null;

  const distKm = (run.distanceM / 1000).toFixed(2);
  const elapsed = formatTime(run.elapsedS);
  const pace =
    run.avgPaceSPerKm > 0 && isFinite(run.avgPaceSPerKm)
      ? formatPace(run.avgPaceSPerKm)
      : '--:--';
  // Slower than 30:00 /km = walking pace or standing: show no pace
  const currentPace =
    run.currentPaceSPerKm > 0 && run.currentPaceSPerKm < 1800 && isFinite(run.currentPaceSPerKm)
      ? formatPace(run.currentPaceSPerKm)
      : '--:--';

  // Route coordinates for polyline
  const routeCoords = useMemo(
    () =>
      run.validPoints.map((p) => ({
        latitude: p.latitude,
        longitude: p.longitude,
      })),
    [run.validPoints],
  );

  // Current runner position: the smoothed position (updated every good fix;
  // route points are only added at confirmed steps)
  const currentPosition =
    run.position ??
    (run.validPoints.length > 0 ? run.validPoints[run.validPoints.length - 1] : null);

  // Ghost = the personal-best run on this route, replayed by elapsed time
  const hasGhost = run.ghostCheckpoints.length >= 2;
  const ghostDistM = hasGhost ? ghostDistanceAtTime(run.ghostCheckpoints, run.elapsedS) : 0;
  const ghostPosition = useMemo(
    () => (hasGhost ? getPositionAlongRoute(run.ghostTrack, ghostDistM) : null),
    [hasGhost, run.ghostTrack, ghostDistM],
  );

  // Ghost time gap (±Δt), refreshed at every 10 m mark: negative = ahead
  const ghostDelta = run.ghostDeltaS;
  const ghostLeadText = !hasGhost
    ? 'First run sets your ghost'
    : run.ghostFinished
      ? 'Past the ghost finish'
      : ghostDelta === null
        ? 'Ghost ready'
        : ghostDelta <= 0
          ? `${Math.abs(ghostDelta).toFixed(1)} s ahead`
          : `${ghostDelta.toFixed(1)} s behind`;
  const ghostLeadColor =
    ghostDelta === null || run.ghostFinished ? colors.textDim : ghostDelta <= 0 ? colors.accent : colors.textDim;

  // Live RII against the PB pace on this route
  const liveRII =
    run.pbPaceSPerKm && run.avgPaceSPerKm > 0 && isFinite(run.avgPaceSPerKm)
      ? calculateRII(run.pbPaceSPerKm, run.avgPaceSPerKm)
      : 0;
  const riiStatus = getRIIStatus(liveRII);

  // ── Competition data ────────────────────────────────
  const peer = competition.peerPosition;
  const hasPeer = peer !== null && competition.p2pStatus === 'connected';

  // Peer lead/lag (based on distance)
  const peerLead = hasPeer ? run.distanceM - (peer?.distanceM || 0) : 0;
  const peerLeadText = peerLead >= 0
    ? `+${Math.round(peerLead)}m ahead`
    : `${Math.round(Math.abs(peerLead))}m behind`;
  const peerLeadColor = peerLead >= 0 ? colors.accent : colors.danger;

  // Auto-follow camera (peers share no coordinates, so only the local runner is followed)
  useEffect(() => {
    if (followCamera && currentPosition && mapRef.current) {
      animateMapToRegion(mapRef, {
        latitude: currentPosition.latitude,
        longitude: currentPosition.longitude,
        latitudeDelta: 0.004,
        longitudeDelta: 0.004,
      }, 500);
    }
  }, [currentPosition?.latitude, currentPosition?.longitude, followCamera]);

  // Map region for first load
  const initialRegion = currentPosition
    ? {
        latitude: currentPosition.latitude,
        longitude: currentPosition.longitude,
        latitudeDelta: 0.004,
        longitudeDelta: 0.004,
      }
    : {
        latitude: 6.8448,
        longitude: 79.8999,
        latitudeDelta: 0.005,
        longitudeDelta: 0.005,
      };

  // 5-run baseline: no scores during the first 5 runs
  const runNo = run.calibrationAtStart.runs + 1;
  const calibrating = runNo < CALIBRATION_RUNS;
  const routeColor = inRace ? RACE_COLOR : SOLO_COLOR;

  return (
    <View style={styles.runContainer}>
      {/* ── Map: always visible, follows the runner ─────── */}
      <View style={styles.liveMapArea}>
        <RunningMap
          mapRef={mapRef}
          initialRegion={initialRegion}
          routeCoords={routeCoords}
          currentPosition={currentPosition}
          ghostPosition={ghostPosition}
          peerPosition={null}
          raceColors={raceColors ?? { me: SOLO_COLOR, friend: RACE_FRIEND_COLOR, route: routeColor }}
          onPanDrag={() => setFollowCamera(false)}
        />

        <View style={styles.mapTopOverlay}>
          <View style={styles.liveBar}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>RECORDING</Text>
            {!currentPosition && <Text style={styles.gpsCount}>waiting for GPS…</Text>}
          </View>
        </View>

        {!followCamera && Platform.OS !== 'web' && (
          <IconButton icon="locate" onPress={() => setFollowCamera(true)} accessibilityLabel="Re-centre map" style={styles.recenterBtn} />
        )}

        {hasGhost && (
          <View style={styles.ghostOverlay}>
            <Text style={styles.ghostOverlayLabel}>👻</Text>
            <Text style={[styles.ghostOverlayText, { color: ghostLeadColor }]}>{ghostLeadText}</Text>
          </View>
        )}
      </View>

      {/* ── Panel: the numbers that matter, large ────────── */}
      <View style={styles.livePanel}>
        <RaceStrip />

        <View style={styles.bigRow}>
          <View style={styles.bigCell}>
            <Text style={styles.bigValue} numberOfLines={1} adjustsFontSizeToFit>{elapsed}</Text>
            <Text style={styles.bigLabel}>TIME</Text>
          </View>
          <View style={styles.bigCell}>
            <Text style={[styles.bigValue, { color: routeColor }]} numberOfLines={1} adjustsFontSizeToFit>{distKm}</Text>
            <Text style={styles.bigLabel}>KM</Text>
          </View>
          <View style={styles.bigCell}>
            <Text style={styles.bigValue} numberOfLines={1} adjustsFontSizeToFit>{currentPace}</Text>
            <Text style={styles.bigLabel}>PACE /KM</Text>
          </View>
        </View>

        <Text style={styles.smallLine} numberOfLines={1}>
          avg {pace}/km
          {!hasGhost ? ' · first run sets your ghost' : ''}
          {calibrating
            ? ` · baseline run ${runNo} of ${CALIBRATION_RUNS}`
            : liveRII > 0
              ? ` · RII ${liveRII.toFixed(2)}`
              : ''}
        </Text>
        {!currentPosition && (
          <Text style={styles.gpsHint}>
            Acquiring GPS… without internet the first fix can take a few minutes; best outdoors.
          </Text>
        )}

        <View style={styles.stopRow}>
          <Button label="Stop run" icon="stop" variant="danger" onPress={onStop} style={styles.stopButton} />
        </View>
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════
// FINISHED VIEW — Summary + Route Map
// ═══════════════════════════════════════════════════════════

function FinishedView({
  run,
  onReset,
}: {
  run: RunState;
  onReset: () => void;
}) {
  const mapRef = useRef<any>(null);
  const distKm = (run.distanceM / 1000).toFixed(2);
  const elapsed = formatTime(run.elapsedS);
  const pace = formatPace(run.avgPaceSPerKm);

  const routeCoords = useMemo(
    () =>
      run.validPoints.map((p) => ({
        latitude: p.latitude,
        longitude: p.longitude,
      })),
    [run.validPoints],
  );

  // Fit map to route
  useEffect(() => {
    if (mapRef.current && routeCoords.length >= 2) {
      setTimeout(() => {
        mapRef.current?.fitToCoordinates(routeCoords, {
          edgePadding: { top: 40, right: 40, bottom: 40, left: 40 },
          animated: true,
        });
      }, 500);
    }
  }, [routeCoords]);

  // RII vs the personal best that was in place when this run started
  // (the same value the run is saved with). No PB yet = first run here.
  const pbPace = run.pbPaceSPerKm;
  const rii =
    pbPace && run.avgPaceSPerKm > 0 && isFinite(run.avgPaceSPerKm)
      ? calculateRII(pbPace, run.avgPaceSPerKm)
      : 0;

  // 5-run baseline: this run's number among valid runs
  const { calibration } = useRun();
  const { profile: me } = useProfile();
  const hasPace = run.distanceM >= 10 && run.avgPaceSPerKm > 0 && isFinite(run.avgPaceSPerKm);
  const runNo = hasPace ? run.calibrationAtStart.runs + 1 : null;
  // Baseline is fixed at run 5; on the 5th run itself it is known once saved
  const baselinePace = run.calibrationAtStart.baselinePace ?? calibration.baselinePace;
  const npi =
    hasPace && me.physicalSaved
      ? calculateNPI(
          { age: me.age, weightKg: me.weightKg, heightCm: me.heightCm, bmi: me.bmi, gender: me.gender },
          { altitudeM: run.currentAltitudeM ?? 15, distanceM: run.distanceM, avgPaceSPerKm: run.avgPaceSPerKm },
        ).npi
      : null;

  const initialRegion = routeCoords.length > 0
    ? {
        latitude: routeCoords[0].latitude,
        longitude: routeCoords[0].longitude,
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      }
    : {
        latitude: 6.8448,
        longitude: 79.8999,
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      };

  return (
    <ScrollView
      style={styles.finishedScroll}
      contentContainerStyle={styles.finishedContent}
      showsVerticalScrollIndicator={false}
    >
      {/* Route Map */}
      {routeCoords.length >= 2 && (
        <View style={styles.finishedMapContainer}>
          <FinishedMap
            mapRef={mapRef}
            initialRegion={initialRegion}
            routeCoords={routeCoords}
          />
          <View style={styles.finishedMapBadge}>
            <Text style={styles.finishedMapBadgeText}>RUN COMPLETE</Text>
          </View>
        </View>
      )}

      {/* Summary Header */}
      <View style={styles.finishHeader}>
        <Text style={styles.finishTitle}>Great Run</Text>
      </View>

      {/* Summary Card */}
      <View style={styles.summaryCard}>
        <View style={styles.summaryRow}>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryValue}>{distKm}</Text>
            <Text style={styles.summaryLabel}>km</Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryValue}>{elapsed}</Text>
            <Text style={styles.summaryLabel}>time</Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryValue}>{pace}</Text>
            <Text style={styles.summaryLabel}>/km</Text>
          </View>
        </View>
        {/* Elevation row */}
        <View style={[styles.summaryRow, { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border }]}>
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryValue, { fontFamily: 'Urbanist_400Regular', color: colors.accent, fontSize: 18 }]}>↑{Math.round(run.elevationGainM)}m</Text>
            <Text style={styles.summaryLabel}>Elev Gain</Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryValue, { fontFamily: 'Urbanist_400Regular', color: colors.danger, fontSize: 18 }]}>↓{Math.round(run.elevationLossM)}m</Text>
            <Text style={styles.summaryLabel}>Elev Loss</Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryValue, { fontSize: 18 }]}>{Math.round(run.elevationGainM - run.elevationLossM)}m</Text>
            <Text style={styles.summaryLabel}>Net Elev</Text>
          </View>
        </View>
      </View>

      {/* Scores: baseline progress during the first 5 runs, then NPI / RII / vs baseline */}
      <RunScores
        runNo={runNo}
        pace={hasPace ? run.avgPaceSPerKm : null}
        npi={npi}
        rii={rii > 0 ? rii : null}
        pbPace={pbPace}
        baselinePace={baselinePace}
        npiMissingHint="save your profile"
      />

      {/* GPS Stats */}
      <View style={styles.gpsStatsCard}>
        <Text style={styles.gpsStatsTitle}>GPS QUALITY</Text>
        <View style={styles.gpsStatsRow}>
          <View style={styles.gpsStatItem}>
            <Text style={styles.gpsStatValue}>{run.points.length}</Text>
            <Text style={styles.gpsStatLabel}>Total</Text>
          </View>
          <View style={styles.gpsStatItem}>
            <Text style={[styles.gpsStatValue, { color: colors.accent }]}>
              {run.validPoints.length}
            </Text>
            <Text style={styles.gpsStatLabel}>Valid</Text>
          </View>
          <View style={styles.gpsStatItem}>
            <Text style={[styles.gpsStatValue, { color: colors.danger }]}>
              {run.filteredCount}
            </Text>
            <Text style={styles.gpsStatLabel}>Filtered</Text>
          </View>
        </View>
      </View>

      {/* Splits */}
      {run.splitPaces.length > 0 && (
        <View style={styles.gpsStatsCard}>
          <Text style={styles.gpsStatsTitle}>KM SPLITS</Text>
          {run.splitPaces.map((p, i) => (
            <View key={i} style={styles.splitRow}>
              <Text style={styles.splitKm}>km {i + 1}</Text>
              <Text style={styles.splitPace}>{formatPace(p)} /km</Text>
            </View>
          ))}
        </View>
      )}

      <Button label="New run" icon="add" onPress={onReset} style={styles.resetButton} />

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

// ═══════════════════════════════════════════════════════════
// DARK MAP STYLE
// ═══════════════════════════════════════════════════════════

const darkMapStyle = [
  { elementType: 'geometry', stylers: [{ color: colors.bg }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: colors.bg }] },
  { elementType: 'labels.text.fill', stylers: [{ color: colors.textFaint }] },
  {
    featureType: 'road',
    elementType: 'geometry',
    stylers: [{ color: colors.surface }],
  },
  {
    featureType: 'road',
    elementType: 'geometry.stroke',
    stylers: [{ color: colors.elevated }],
  },
  {
    featureType: 'road.highway',
    elementType: 'geometry',
    stylers: [{ color: colors.elevated }],
  },
  {
    featureType: 'water',
    elementType: 'geometry',
    stylers: [{ color: colors.surface }],
  },
  {
    featureType: 'poi',
    elementType: 'geometry',
    stylers: [{ color: colors.surface }],
  },
  {
    featureType: 'poi.park',
    elementType: 'geometry',
    stylers: [{ color: colors.surface }],
  },
  {
    featureType: 'transit',
    elementType: 'geometry',
    stylers: [{ color: colors.surface }],
  },
  {
    featureType: 'poi',
    elementType: 'labels',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'transit',
    elementType: 'labels',
    stylers: [{ visibility: 'off' }],
  },
];

// ═══════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  // Pre-run (revamp): map + top card + bottom panel
  preTop: { position: 'absolute', top: 44, left: 16, right: 16, zIndex: 5 },
  preTopCard: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  preScroll: { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '62%' },
  preBottom: { paddingHorizontal: 16, paddingBottom: 16, gap: 12 },
  preRow: { flexDirection: 'row', gap: 12, alignItems: 'stretch' },
  preStatus: { flex: 1, justifyContent: 'center' },
  preStatusLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  gpsDot: { width: 10, height: 10, borderRadius: 5 },
  // shared Button, just bigger: the main action of the screen
  preStart: { width: 120, height: undefined, minHeight: 120, flexDirection: 'column' },
  preStartText: { fontFamily: fonts.extrabold, fontSize: 20, letterSpacing: 1.5, color: colors.onAccent },
  // ── IDLE ──────────────────────────────────────────────
  idleContainer: {
    flex: 1,
  },
  idleMapContainer: {
    ...StyleSheet.absoluteFill,
  },
  idleMapOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.scrim,
  },
  idleScroll: {
    flex: 1,
  },
  idleContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingTop: 72, // below the OFFLINE / SYNC chips
    paddingBottom: 24,
  },
  idleTitle: {
    fontSize: 32,
    fontFamily: 'Urbanist_400Regular',
    color: colors.text,
    marginBottom: 8,
    letterSpacing: 3,
  },
  idleSub: {
    fontFamily: 'Urbanist_400Regular',
    fontSize: 14,
    color: colors.textDim,
    textAlign: 'center',
    lineHeight: 22,
  },
  startButton: {
    marginTop: 40,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 30,
    elevation: 10,
  },
  startButtonText: {
    fontSize: 22,
    fontFamily: 'Urbanist_700Bold',
    color: colors.bg,
    letterSpacing: 3,
  },
  infoRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 40,
  },
  infoPill: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  infoPillText: {
    fontSize: 10,
    color: colors.textDim,
    fontFamily: 'Urbanist_600SemiBold',
    letterSpacing: 1,
  },
  locationReady: {
    marginTop: 24,
    fontSize: 11,
    color: colors.accent,
    letterSpacing: 1,
    fontFamily: 'Urbanist_500Medium',
  },

  // ── SYNC BUTTON (top-right) ───────────────────────────
  syncButton: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 56 : 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.overlay,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    zIndex: 10,
  },
  syncButtonConnected: {
    ...glassFill('green'),
  },
  syncDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  syncButtonText: {
    fontSize: 12,
    fontFamily: 'Urbanist_700Bold',
    color: colors.textDim,
    letterSpacing: 1,
  },

  // ── PEER DISCOVERY MODAL ──────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: 'Urbanist_700Bold',
    color: colors.text,
  },
  modalClose: {
    fontFamily: 'Urbanist_400Regular',
    fontSize: 22,
    color: colors.textDim,
    padding: 4,
  },
  modalDesc: {
    fontFamily: 'Urbanist_400Regular',
    fontSize: 14,
    color: colors.textDim,
    lineHeight: 20,
    marginBottom: 20,
  },
  modalInputLabel: {
    fontSize: 11,
    fontFamily: 'Urbanist_600SemiBold',
    color: colors.textDim,
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  modalInput: {
    backgroundColor: colors.elevated,
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.accent,
    marginBottom: 16,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  modalConnectBtn: {
    backgroundColor: colors.accent,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
  modalConnectBtnText: {
    color: colors.text,
    fontSize: 16,
    fontFamily: 'Urbanist_600SemiBold',
  },
  modalError: {
    fontFamily: 'Urbanist_400Regular',
    color: colors.danger,
    fontSize: 13,
    marginTop: 8,
    textAlign: 'center',
  },
  modalWaiting: {
    fontFamily: 'Urbanist_400Regular',
    color: colors.textDim,
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 12,
    fontStyle: 'italic',
  },
  // ── Nearby Devices / Scanning ─────────────────────────
  nearbyTitle: {
    fontSize: 12,
    fontFamily: 'Urbanist_700Bold',
    color: colors.textDim,
    letterSpacing: 1,
    marginBottom: 12,
  },
  scanningBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    backgroundColor: colors.elevated,
    borderRadius: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
  },
  scanningDots: {
    fontFamily: 'Urbanist_400Regular',
    fontSize: 24,
    color: colors.accent,
    marginBottom: 12,
    letterSpacing: 4,
  },
  scanningText: {
    fontSize: 15,
    fontFamily: 'Urbanist_600SemiBold',
    color: colors.text,
    marginBottom: 6,
  },
  scanningHint: {
    fontFamily: 'Urbanist_400Regular',
    fontSize: 13,
    color: colors.textDim,
    textAlign: 'center',
    paddingHorizontal: 20,
  },

  // Peer card
  peerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.elevated,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    ...glassFill('green'),
  },
  peerCardDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.accent,
    marginRight: 12,
  },
  peerCardInfo: { flex: 1 },
  peerCardName: {
    fontSize: 16,
    fontFamily: 'Urbanist_700Bold',
    color: colors.text,
  },
  peerCardStatus: {
    fontFamily: 'Urbanist_400Regular',
    fontSize: 12,
    color: colors.accent,
    marginTop: 2,
  },

  // Modal race buttons
  modalStartRaceBtn: {
    backgroundColor: colors.accent,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
  modalStartRaceBtnText: {
    color: colors.bg,
    fontSize: 18,
    fontFamily: 'Urbanist_800ExtraBold',
    letterSpacing: 1,
  },
  modalDisconnectBtn: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalDisconnectBtnText: {
    color: colors.danger,
    fontSize: 14,
    fontFamily: 'Urbanist_600SemiBold',
  },

  // ── COMPETITION OVERLAY (during run) ──────────────────
  competitionCard: {
    width: '100%',
    marginTop: 10,
    backgroundColor: colors.glass,
    borderRadius: 20,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    ...glassFill('neutral'),
  },
  competitionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  competitionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.peer,
    marginRight: 8,
  },
  competitionTitle: {
    flex: 1,
    fontSize: 12,
    fontFamily: 'Urbanist_700Bold',
    color: colors.peer,
    letterSpacing: 1,
  },
  competitionLead: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'Urbanist_700Bold',
  },
  competitionStats: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  competitionStatItem: { flex: 1, alignItems: 'center' },
  competitionStatValue: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
    fontFamily: 'Urbanist_700Bold',
  },
  competitionStatLabel: {
    fontSize: 9,
    color: colors.textDim,
    marginTop: 2,
    fontFamily: 'Urbanist_600SemiBold',
    letterSpacing: 0.5,
  },
  competitionDivider: {
    width: 1,
    height: 28,
    backgroundColor: colors.border,
  },
  competitionNpiRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  competitionNpiLabel: {
    fontSize: 11,
    color: colors.textDim,
    fontFamily: 'Urbanist_500Medium',
  },
  competitionNpiValue: {
    fontSize: 13,
    fontFamily: 'Urbanist_700Bold',
  },

  // ── RUNNING ───────────────────────────────────────────
  runContainer: {
    flex: 1,
    backgroundColor: colors.onAccent,
  },

  // Running: map on top (always visible), numbers panel below
  liveMapArea: {
    flex: 1,
    overflow: 'hidden',
  },
  livePanel: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    marginTop: -24, // overlap the map edge slightly
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 12, // the tab bar sits below (solid)
  },
  bigRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  bigCell: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  bigValue: {
    color: colors.text,
    fontSize: 42,
    fontFamily: fonts.bold,
    fontVariant: ['tabular-nums'],
    letterSpacing: -1,
  },
  bigLabel: {
    color: colors.textDim,
    fontSize: 12,
    fontFamily: fonts.semibold,
    letterSpacing: 1.2,
    marginTop: 2,
  },
  smallLine: {
    color: colors.textDim,
    fontSize: 14,
    fontFamily: fonts.medium,
    textAlign: 'center',
    marginTop: 10,
    fontVariant: ['tabular-nums'],
  },
  gpsHint: {
    color: colors.warn,
    fontFamily: fonts.medium,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 6,
  },
  stopRow: {
    alignItems: 'center',
    marginTop: 12,
  },

  // Map
  mapWrapper: {
    ...StyleSheet.absoluteFill,
    position: 'absolute',
    zIndex: 0,
  },
  mapTopOverlay: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 60 : 30,
    left: 12,
    right: 12,
    alignItems: 'flex-start',
    zIndex: 10,
  },
  liveBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 14,
    backgroundColor: colors.dangerDim,
    borderRadius: 20,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.danger,
  },
  liveText: {
    fontSize: 10,
    fontFamily: 'Urbanist_700Bold',
    color: colors.danger,
    letterSpacing: 2,
  },
  gpsCount: { fontFamily: 'Urbanist_400Regular', fontSize: 10, color: colors.textDim, marginLeft: 4 },

  recenterBtn: {
    position: 'absolute',
    bottom: 30, // the map ends above the numbers panel
    right: 12,
    backgroundColor: colors.overlay,
  },
  recenterIcon: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: colors.text,
  },

  ghostOverlay: {
    position: 'absolute',
    bottom: 30, // the map ends above the numbers panel
    left: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: colors.overlay,
    borderRadius: 16,
  },
  ghostOverlayLabel: {
    fontSize: 10, fontFamily: 'Urbanist_700Bold', color: colors.textDim, letterSpacing: 1,
  },
  ghostOverlayText: { fontSize: 14, fontFamily: fonts.bold },

  // Markers
  runnerMarker: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  runnerMarkerPulse: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.accentDim,
  },
  runnerMarkerDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.accent,
    borderWidth: 3,
    borderColor: colors.white,
  },
  ghostMarker: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.dangerDim,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: colors.danger + '80',
  },
  ghostMarkerInner: {
    flexDirection: 'row',
    gap: 4,
  },
  ghostEye: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.danger,
  },
  startMarker: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startMarkerDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.accent,
    borderWidth: 2,
    borderColor: colors.text,
  },
  finishMarker: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  finishMarkerDotOuter: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  finishMarkerDotInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.bg,
  },

  // Stats panel
  statsPanel: {
    flex: 1,
    backgroundColor: 'transparent',
    zIndex: 1,
  },
  statsPanelContent: {
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 120 : 90,
    paddingBottom: 160,
  },

  // Main distance
  mainStat: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  mainStatValue: {
    fontSize: 72,
    fontWeight: '700',
    color: colors.text,
    fontFamily:
      Platform.OS === 'ios' ? 'Helvetica Neue' : 'sans-serif-condensed',
    textShadowColor: colors.scrim,
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
  },
  mainStatUnit: {
    fontSize: 22,
    fontFamily: 'Urbanist_400Regular',
    color: colors.textFaint,
    marginLeft: 4,
  },

  // Live stats row
  liveStats: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    backgroundColor: colors.overlay,
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 8,
    width: '100%',
    borderWidth: 1,
    borderColor: colors.border,
  },
  liveStatItem: { flex: 1, alignItems: 'center' },
  liveStatValue: {
    fontSize: 22,
    fontWeight: '600',
    color: colors.text,
    fontFamily: 'Urbanist_700Bold',
  },
  liveStatLabel: {
    fontSize: 9,
    color: colors.textFaint,
    marginTop: 4,
    fontFamily: 'Urbanist_600SemiBold',
    letterSpacing: 1,
  },
  divider: { width: 1, height: 36, backgroundColor: colors.border },

  // Live RII
  liveRIIBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    marginTop: 10,
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  liveRIILeft: {},
  liveRIILabel: {
    fontSize: 10, color: colors.textDim, fontFamily: 'Urbanist_600SemiBold', letterSpacing: 1,
  },
  liveRIIValue: { fontSize: 16, fontWeight: '700', fontFamily: 'Urbanist_700Bold', marginTop: 2 },
  ghostLeadBadge: { fontSize: 14, fontWeight: '700', fontFamily: 'Urbanist_700Bold' },

  // Splits
  splitsContainer: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    marginTop: 10,
  },
  splitsTitle: {
    fontSize: 11,
    fontFamily: 'Urbanist_600SemiBold',
    color: colors.textDim,
    marginBottom: 8,
    letterSpacing: 1.5,
  },
  splitRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  splitKm: { fontFamily: 'Urbanist_400Regular', fontSize: 13, color: colors.textDim },
  splitPace: {
    fontSize: 13,
    color: colors.accent,
    fontFamily: 'Urbanist_700Bold',
    fontWeight: '600',
  },

  // GPS indicator
  gpsIndicator: {
    marginTop: 10,
    alignItems: 'center',
  },
  gpsLabel: { fontSize: 10, color: colors.textFaint, fontFamily: 'Urbanist_700Bold' },
  gpsAccuracy: { fontFamily: 'Urbanist_400Regular', fontSize: 10, color: colors.peer, marginTop: 2 },

  // Stop button overlay
  stopAreaOverlay: {
    position: 'absolute',
    bottom: Platform.OS === 'ios' ? 110 : 90,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 100,
  },

  // Peer Map Overlay (Top Right)
  peerMapOverlay: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 60 : 30,
    right: 12,
    alignItems: 'flex-end',
    backgroundColor: colors.overlay,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    zIndex: 10,
  },
  peerMapOverlayLabel: {
    fontSize: 10,
    fontFamily: 'Urbanist_700Bold',
    color: colors.peer,
    letterSpacing: 1,
    marginBottom: 2,
  },
  peerMapOverlayText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Urbanist_700Bold',
    color: colors.text,
  },

  // White round control (as in the design); red square = stop. Distinct
  // from the red "recording" button in the tab bar.
  stopButton: { alignSelf: 'stretch' },
  stopInner: {
    width: 26,
    height: 26,
    backgroundColor: colors.danger,
    borderRadius: 6,
  },
  stopLabelOverlay: {
    marginTop: 12,
    fontSize: 13,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: 2,
    textShadowColor: colors.scrim,
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },

  // ── FINISHED ──────────────────────────────────────────
  finishedScroll: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  finishedContent: {
    paddingHorizontal: 16,
    paddingTop: (StatusBar.currentHeight ?? 24) + 8, // below the status bar
    paddingBottom: 48, // clear of the centre Run button
  },
  finishedMapContainer: {
    height: 220,
    borderRadius: 16,
    overflow: 'hidden',
    marginBottom: 16,
  },
  finishedMapBadge: {
    position: 'absolute',
    top: 10,
    left: 10,
    backgroundColor: colors.overlay,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  finishedMapBadgeText: {
    fontSize: 10,
    fontFamily: 'Urbanist_700Bold',
    color: colors.accent,
    letterSpacing: 1,
  },
  finishHeader: {
    alignItems: 'center',
    marginBottom: 12,
  },
  finishTitle: {
    fontSize: 28,
    fontFamily: 'Urbanist_400Regular',
    color: colors.text,
    letterSpacing: 1,
  },
  summaryCard: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 24,
    marginBottom: 12,
  },
  summaryRow: { flexDirection: 'row' },
  summaryItem: { flex: 1, alignItems: 'center' },
  summaryValue: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.text,
    fontFamily: 'Urbanist_700Bold',
  },
  summaryLabel: {
    fontSize: 10, color: colors.textFaint, marginTop: 4,
    fontFamily: 'Urbanist_600SemiBold', letterSpacing: 1,
  },

  // RII Result
  riiResultCard: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    marginBottom: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    ...glassFill('green'),
  },
  riiResultLabel: {
    fontSize: 10, color: colors.textDim, fontFamily: 'Urbanist_600SemiBold', letterSpacing: 2,
  },
  riiResultValue: {
    fontSize: 48,
    fontWeight: '200',
    fontFamily: 'Urbanist_700Bold',
    marginVertical: 4,
  },
  riiResultDesc: { fontFamily: 'Urbanist_400Regular', fontSize: 12, color: colors.textFaint, marginTop: 4 },

  // GPS Stats
  gpsStatsCard: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  gpsStatsTitle: {
    fontSize: 11,
    fontFamily: 'Urbanist_600SemiBold',
    color: colors.textDim,
    marginBottom: 10,
    letterSpacing: 1.5,
  },
  gpsStatsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  gpsStatItem: { alignItems: 'center' },
  gpsStatValue: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
    fontFamily: 'Urbanist_700Bold',
  },
  gpsStatLabel: {
    fontSize: 10,
    color: colors.textFaint,
    marginTop: 2,
    fontFamily: 'Urbanist_600SemiBold',
    letterSpacing: 0.5,
  },

  // Reset
  resetButton: { marginTop: 8, alignSelf: 'stretch' },
  resetButtonText: {
    fontSize: 14, fontFamily: 'Urbanist_700Bold', color: colors.bg, letterSpacing: 1,
  },
});
