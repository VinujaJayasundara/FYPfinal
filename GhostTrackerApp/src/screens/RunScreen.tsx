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
import { RaceSetupCard, RaceLiveCard } from '../components/RaceUI';
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
  const syncDotColor = isConnected ? '#00FF87' : '#38383A';

  return (
    <View style={styles.idleContainer}>
      {/* Background Map */}
      <View style={styles.idleMapContainer}>
        <IdleMap region={region} />
        <View style={styles.idleMapOverlay} />
      </View>

      {/* ⚡ SYNC Button — Top Right */}
      <TouchableOpacity
        style={[styles.syncButton, isConnected && styles.syncButtonConnected]}
        onPress={() => competition.setShowSyncModal(true)}
      >
        <View style={[styles.syncDot, { backgroundColor: syncDotColor }]} />
        <Text style={[styles.syncButtonText, isConnected && { color: '#00FF87' }]}>
          {isConnected
            ? `${competition.connectedPeerAlias || 'Peer'}`
            : 'SYNC'}
        </Text>
      </TouchableOpacity>

      {/* Content overlay */}
      <View style={styles.idleContent}>
        <Text style={styles.idleTitle}>START YOUR RUN</Text>
        <Text style={styles.idleSub}>
          GPS tracking is ready.{'\n'}
          {isConnected
            ? `🔗 Connected to ${competition.connectedPeerAlias || 'a peer'} — start a competition!`
            : 'Tap SYNC to race a friend.'}
        </Text>

        <TouchableOpacity style={styles.startButton} onPress={onStart}>
          <Text style={styles.startButtonText}>START</Text>
        </TouchableOpacity>

        <FriendConnectButton />
        <RaceSetupCard />

        <View style={styles.infoRow}>
          <View style={styles.infoPill}>
            <Text style={styles.infoPillText}>GPS</Text>
          </View>
          <View style={styles.infoPill}>
            <Text style={styles.infoPillText}>1 Hz</Text>
          </View>
          <View style={styles.infoPill}>
            <Text style={styles.infoPillText}>LIVE MAP</Text>
          </View>
          {isConnected && (
            <View style={[styles.infoPill, { borderColor: '#00FF8750' }]}>
              <Text style={[styles.infoPillText, { color: '#00FF87' }]}>P2P</Text>
            </View>
          )}
        </View>

        {initialLocation && (
          <Text style={styles.locationReady}>
            GPS LOCKED · {initialLocation.latitude.toFixed(4)},{' '}
            {initialLocation.longitude.toFixed(4)}
          </Text>
        )}
      </View>

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
                <Text style={styles.modalTitle}>⚡ P2P COMPETITION</Text>
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
                    placeholderTextColor="#8E8E93"
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    selectionColor="#00FF87"
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
                      {competition.p2pStatus === 'connecting' ? '⏳ Connecting...' : '🔗 Connect to Relay'}
                    </Text>
                  </TouchableOpacity>
                  {competition.p2pStatus === 'error' && (
                    <Text style={styles.modalError}>Connection failed. Check address and try again.</Text>
                  )}
                </>
              ) : (
                <>
                  <Text style={styles.nearbyTitle}>📡 NEARBY DEVICES</Text>

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
                          <Text style={styles.peerCardName}>📱 {peer.alias}</Text>
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
                      <Text style={styles.modalStartRaceBtnText}>🏁 START RACE</Text>
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

  // Connected race: friend's live pin (orange), me blue, purple route
  const { race } = useRace();
  const inRace = race !== null && race.phase !== 'cancelled' && race.me.status !== 'not-started';
  const raceColors = inRace ? { me: RACE_ME_COLOR, friend: RACE_FRIEND_COLOR, route: RACE_COLOR } : null;
  const racePeer =
    inRace && race.friend.latitude !== null && race.friend.longitude !== null
      ? { latitude: race.friend.latitude, longitude: race.friend.longitude, alias: race.friendAlias }
      : null;

  const distKm = (run.distanceM / 1000).toFixed(2);
  const elapsed = formatTime(run.elapsedS);
  const pace =
    run.avgPaceSPerKm > 0 && isFinite(run.avgPaceSPerKm)
      ? formatPace(run.avgPaceSPerKm)
      : '--:--';
  const currentPace =
    run.currentPaceSPerKm > 0 && isFinite(run.currentPaceSPerKm)
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

  // Current runner position
  const currentPosition =
    run.validPoints.length > 0
      ? run.validPoints[run.validPoints.length - 1]
      : null;

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
    ghostDelta === null || run.ghostFinished ? '#888' : ghostDelta <= 0 ? '#00FF87' : '#FF3B30';

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
  const peerLeadColor = peerLead >= 0 ? '#00FF87' : '#FF3B30';

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

  return (
    <View style={styles.runContainer}>
      {/* ── Live Map ────────────────────────────────────── */}
      <View style={styles.mapWrapper}>
        <RunningMap
          mapRef={mapRef}
          initialRegion={initialRegion}
          routeCoords={routeCoords}
          currentPosition={currentPosition}
          ghostPosition={ghostPosition}
          peerPosition={racePeer}
          raceColors={raceColors}
          onPanDrag={() => setFollowCamera(false)}
        />

        {/* Map overlays */}
        <View style={styles.mapTopOverlay}>
          <View style={styles.liveBar}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>RECORDING</Text>
            <Text style={styles.gpsCount}>
              {run.validPoints.length} pts · {run.filteredCount} filtered
            </Text>
          </View>
        </View>

        {/* Re-center button */}
        {!followCamera && Platform.OS !== 'web' && (
          <TouchableOpacity
            style={styles.recenterBtn}
            onPress={() => setFollowCamera(true)}
          >
            <View style={styles.recenterIcon} />
          </TouchableOpacity>
        )}

        {/* Ghost status overlay on map */}
        {hasGhost && (
          <View style={styles.ghostOverlay}>
            <Text style={styles.ghostOverlayLabel}>GHOST</Text>
            <Text style={[styles.ghostOverlayText, { color: ghostLeadColor }]}>
              {ghostLeadText}
            </Text>
          </View>
        )}

        {/* Peer status overlay on map */}
        {hasPeer && peer && (
          <View style={styles.peerMapOverlay}>
            <Text style={styles.peerMapOverlayLabel}>{peer.alias.toUpperCase()}</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Text style={styles.peerMapOverlayText}>
                NPI {peer.npiScore !== null ? peer.npiScore.toFixed(2) : '-.--'}
              </Text>
              <Text style={[styles.peerMapOverlayText, { color: peerLeadColor }]}>
                {peerLeadText}
              </Text>
            </View>
          </View>
        )}
      </View>

      {/* ── Stats Panel ─────────────────────────────────── */}
      <ScrollView
        style={styles.statsPanel}
        contentContainerStyle={styles.statsPanelContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Connected race: live gap and both runners */}
        <RaceLiveCard />

        {/* Main distance */}
        <View style={styles.mainStat}>
          <Text style={styles.mainStatValue}>{distKm}</Text>
          <Text style={styles.mainStatUnit}>km</Text>
        </View>

        {/* Stats grid */}
        <View style={styles.liveStats}>
          <View style={styles.liveStatItem}>
            <Text style={styles.liveStatValue}>{elapsed}</Text>
            <Text style={styles.liveStatLabel}>Duration</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.liveStatItem}>
            <Text style={styles.liveStatValue}>{pace}</Text>
            <Text style={styles.liveStatLabel}>Avg Pace</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.liveStatItem}>
            <Text style={styles.liveStatValue}>{currentPace}</Text>
            <Text style={styles.liveStatLabel}>Current</Text>
          </View>
        </View>

        {/* Elevation stats */}
        <View style={styles.liveStats}>
          <View style={styles.liveStatItem}>
            <Text style={[styles.liveStatValue, { color: '#00FF87' }]}>
              ↑{Math.round(run.elevationGainM)}m
            </Text>
            <Text style={styles.liveStatLabel}>Elev Gain</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.liveStatItem}>
            <Text style={[styles.liveStatValue, { color: '#FF3B30' }]}>
              ↓{Math.round(run.elevationLossM)}m
            </Text>
            <Text style={styles.liveStatLabel}>Elev Loss</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.liveStatItem}>
            <Text style={styles.liveStatValue}>
              {run.currentAltitudeM !== null ? `${Math.round(run.currentAltitudeM)}m` : '--'}
            </Text>
            <Text style={styles.liveStatLabel}>Altitude</Text>
          </View>
        </View>

        {/* Live RII and ghost time gap vs the personal best */}
        <View style={styles.liveRIIBar}>
          <View style={styles.liveRIILeft}>
            <Text style={styles.liveRIILabel}>VS GHOST</Text>
            <Text style={[styles.liveRIIValue, { color: riiStatus.color }]}>
              RII {liveRII > 0 ? liveRII.toFixed(3) : '-.---'}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[styles.ghostLeadBadge, { color: ghostLeadColor }]}>
              {ghostLeadText}
            </Text>
            {run.ghostSplitDistanceM !== null && !run.ghostFinished && (
              <Text style={styles.liveRIILabel}>at {run.ghostSplitDistanceM} m</Text>
            )}
          </View>
        </View>

        {/* ── COMPETITION OVERLAY ─────────────────────── */}
        {hasPeer && peer && (
          <View style={styles.competitionCard}>
            <View style={styles.competitionHeader}>
              <View style={styles.competitionDot} />
              <Text style={styles.competitionTitle}>VS {(peer.alias || 'PEER').toUpperCase()}</Text>
              <Text style={[styles.competitionLead, { color: peerLeadColor }]}>
                {peerLeadText}
              </Text>
            </View>

            <View style={styles.competitionStats}>
              <View style={styles.competitionStatItem}>
                <Text style={styles.competitionStatLabel}>NPI</Text>
                <Text style={styles.competitionStatValue}>
                  {(() => {
                    if (run.avgPaceSPerKm > 0 && isFinite(run.avgPaceSPerKm) && profile.age > 0) {
                      const res = calculateNPI(
                        { age: profile.age, weightKg: profile.weightKg, heightCm: profile.heightCm, bmi: profile.bmi, gender: profile.gender },
                        { altitudeM: run.currentAltitudeM ?? 15, distanceM: run.distanceM, avgPaceSPerKm: run.avgPaceSPerKm },
                      );
                      return formatNPI(res.npi);
                    }
                    return '-.--';
                  })()}
                </Text>
                <Text style={styles.competitionStatLabel}>YOU</Text>
              </View>
              <View style={styles.competitionDivider} />
              <View style={styles.competitionStatItem}>
                <Text style={styles.competitionStatLabel}>NPI</Text>
                <Text style={[styles.competitionStatValue, { color: '#0A84FF' }]}>
                  {peer.npiScore !== null ? formatNPI(peer.npiScore) : '-.--'}
                </Text>
                <Text style={styles.competitionStatLabel}>THEM</Text>
              </View>
              <View style={styles.competitionDivider} />
              <View style={styles.competitionStatItem}>
                <Text style={styles.competitionStatLabel}>PACE</Text>
                <Text style={styles.competitionStatValue}>
                  {run.avgPaceSPerKm > 0 && isFinite(run.avgPaceSPerKm) ? formatPace(run.avgPaceSPerKm) : '--:--'}
                </Text>
                <Text style={styles.competitionStatLabel}>YOU</Text>
              </View>
              <View style={styles.competitionDivider} />
              <View style={styles.competitionStatItem}>
                <Text style={styles.competitionStatLabel}>PACE</Text>
                <Text style={[styles.competitionStatValue, { color: '#0A84FF' }]}>
                  {peer.avgPaceSPerKm > 0 && isFinite(peer.avgPaceSPerKm) ? formatPace(peer.avgPaceSPerKm) : '--:--'}
                </Text>
                <Text style={styles.competitionStatLabel}>THEM</Text>
              </View>
            </View>

            {peer.npiScore !== null && (
              <View style={styles.competitionNpiRow}>
                <Text style={styles.competitionNpiLabel}>Their Performance:</Text>
                <Text style={[styles.competitionNpiValue, { color: getNPIStatus(peer.npiScore).color }]}>
                  {getNPIStatus(peer.npiScore).emoji} {getNPIStatus(peer.npiScore).label}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Split times */}
        {run.splitPaces.length > 0 && (
          <View style={styles.splitsContainer}>
            <Text style={styles.splitsTitle}>SPLITS</Text>
            {run.splitPaces.map((p, i) => (
              <View key={i} style={styles.splitRow}>
                <Text style={styles.splitKm}>km {i + 1}</Text>
                <Text style={styles.splitPace}>{formatPace(p)} /km</Text>
              </View>
            ))}
          </View>
        )}

        {/* GPS accuracy */}
        <View style={styles.gpsIndicator}>
          <Text style={styles.gpsLabel}>
            {currentPosition
              ? `${currentPosition.latitude.toFixed(5)}, ${currentPosition.longitude.toFixed(5)}`
              : 'ACQUIRING GPS...'}
          </Text>
          {currentPosition?.accuracy && (
            <Text style={styles.gpsAccuracy}>
              ±{currentPosition.accuracy.toFixed(0)}m accuracy
            </Text>
          )}
        </View>

      </ScrollView>

      {/* Stop Button Overlay */}
      <View style={styles.stopAreaOverlay}>
        <TouchableOpacity style={styles.stopButton} onPress={onStop}>
          <View style={styles.stopInner} />
        </TouchableOpacity>
        <Text style={styles.stopLabelOverlay}>STOP</Text>
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

  // RII comparison
  const pbPace = 360;
  const rii =
    run.avgPaceSPerKm > 0 && isFinite(run.avgPaceSPerKm)
      ? calculateRII(pbPace, run.avgPaceSPerKm)
      : 0;
  const riiStatus = getRIIStatus(rii);

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
        <View style={[styles.summaryRow, { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#38383A' }]}>
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryValue, { color: '#00FF87', fontSize: 18 }]}>↑{Math.round(run.elevationGainM)}m</Text>
            <Text style={styles.summaryLabel}>Elev Gain</Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryValue, { color: '#FF3B30', fontSize: 18 }]}>↓{Math.round(run.elevationLossM)}m</Text>
            <Text style={styles.summaryLabel}>Elev Loss</Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryValue, { fontSize: 18 }]}>{Math.round(run.elevationGainM - run.elevationLossM)}m</Text>
            <Text style={styles.summaryLabel}>Net Elev</Text>
          </View>
        </View>
      </View>

      {/* RII Score */}
      {rii > 0 && (
        <View style={styles.riiResultCard}>
          <Text style={styles.riiResultLabel}>RII Score</Text>
          <Text style={[styles.riiResultValue, { color: riiStatus.color }]}>
            {rii.toFixed(3)}
          </Text>
          <Text
            style={{ color: riiStatus.color, fontWeight: '600', fontSize: 14 }}
          >
            {riiStatus.label}
          </Text>
          <Text style={styles.riiResultDesc}>
            vs PB of {formatPace(pbPace)} /km
          </Text>
        </View>
      )}

      {/* GPS Stats */}
      <View style={styles.gpsStatsCard}>
        <Text style={styles.gpsStatsTitle}>GPS QUALITY</Text>
        <View style={styles.gpsStatsRow}>
          <View style={styles.gpsStatItem}>
            <Text style={styles.gpsStatValue}>{run.points.length}</Text>
            <Text style={styles.gpsStatLabel}>Total</Text>
          </View>
          <View style={styles.gpsStatItem}>
            <Text style={[styles.gpsStatValue, { color: '#00FF87' }]}>
              {run.validPoints.length}
            </Text>
            <Text style={styles.gpsStatLabel}>Valid</Text>
          </View>
          <View style={styles.gpsStatItem}>
            <Text style={[styles.gpsStatValue, { color: '#FF3B30' }]}>
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

      <TouchableOpacity style={styles.resetButton} onPress={onReset}>
        <Text style={styles.resetButtonText}>NEW RUN</Text>
      </TouchableOpacity>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

// ═══════════════════════════════════════════════════════════
// DARK MAP STYLE
// ═══════════════════════════════════════════════════════════

const darkMapStyle = [
  { elementType: 'geometry', stylers: [{ color: '#0a0e1a' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0a0e1a' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#64748b' }] },
  {
    featureType: 'road',
    elementType: 'geometry',
    stylers: [{ color: '#1a1f35' }],
  },
  {
    featureType: 'road',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#2a3050' }],
  },
  {
    featureType: 'road.highway',
    elementType: 'geometry',
    stylers: [{ color: '#2a3050' }],
  },
  {
    featureType: 'water',
    elementType: 'geometry',
    stylers: [{ color: '#0f1729' }],
  },
  {
    featureType: 'poi',
    elementType: 'geometry',
    stylers: [{ color: '#111827' }],
  },
  {
    featureType: 'poi.park',
    elementType: 'geometry',
    stylers: [{ color: '#0f1f15' }],
  },
  {
    featureType: 'transit',
    elementType: 'geometry',
    stylers: [{ color: '#111827' }],
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
  // ── IDLE ──────────────────────────────────────────────
  idleContainer: {
    flex: 1,
  },
  idleMapContainer: {
    ...StyleSheet.absoluteFill,
  },
  idleMapOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
  },
  idleContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  idleTitle: {
    fontSize: 32,
    fontWeight: '200',
    color: '#FFFFFF',
    marginBottom: 8,
    letterSpacing: 3,
  },
  idleSub: {
    fontSize: 14,
    color: '#8E8E93',
    textAlign: 'center',
    lineHeight: 22,
  },
  startButton: {
    marginTop: 40,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: '#00FF87',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#00FF87',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 30,
    elevation: 10,
  },
  startButtonText: {
    fontSize: 22,
    fontWeight: '700',
    color: '#000000',
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
    borderColor: '#38383A',
  },
  infoPillText: {
    fontSize: 10,
    color: '#8E8E93',
    fontWeight: '600',
    letterSpacing: 1,
  },
  locationReady: {
    marginTop: 24,
    fontSize: 11,
    color: '#00FF87',
    letterSpacing: 1,
    fontWeight: '500',
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
    backgroundColor: 'rgba(28, 28, 30, 0.85)',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#38383A',
    zIndex: 10,
  },
  syncButtonConnected: {
    borderColor: '#00FF8750',
    backgroundColor: 'rgba(0, 255, 135, 0.08)',
  },
  syncDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  syncButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#8E8E93',
    letterSpacing: 1,
  },

  // ── PEER DISCOVERY MODAL ──────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#1C1C1E',
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
    fontWeight: '700',
    color: '#FFFFFF',
  },
  modalClose: {
    fontSize: 22,
    color: '#8E8E93',
    padding: 4,
  },
  modalDesc: {
    fontSize: 14,
    color: '#8E8E93',
    lineHeight: 20,
    marginBottom: 20,
  },
  modalInputLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#8E8E93',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  modalInput: {
    backgroundColor: '#2C2C2E',
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#00FF87',
    marginBottom: 16,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  modalConnectBtn: {
    backgroundColor: '#0A84FF',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
  modalConnectBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  modalError: {
    color: '#FF3B30',
    fontSize: 13,
    marginTop: 8,
    textAlign: 'center',
  },
  modalWaiting: {
    color: '#FF9F0A',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 12,
    fontStyle: 'italic',
  },
  // ── Nearby Devices / Scanning ─────────────────────────
  nearbyTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#8E8E93',
    letterSpacing: 1,
    marginBottom: 12,
  },
  scanningBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    backgroundColor: '#2C2C2E',
    borderRadius: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#38383A',
    borderStyle: 'dashed',
  },
  scanningDots: {
    fontSize: 24,
    color: '#00FF87',
    marginBottom: 12,
    letterSpacing: 4,
  },
  scanningText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 6,
  },
  scanningHint: {
    fontSize: 13,
    color: '#8E8E93',
    textAlign: 'center',
    paddingHorizontal: 20,
  },

  // Peer card
  peerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2C2C2E',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#00FF8730',
  },
  peerCardDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#00FF87',
    marginRight: 12,
  },
  peerCardInfo: { flex: 1 },
  peerCardName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  peerCardStatus: {
    fontSize: 12,
    color: '#00FF87',
    marginTop: 2,
  },

  // Modal race buttons
  modalStartRaceBtn: {
    backgroundColor: '#00FF87',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
  modalStartRaceBtnText: {
    color: '#000000',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 1,
  },
  modalDisconnectBtn: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalDisconnectBtnText: {
    color: '#FF3B30',
    fontSize: 14,
    fontWeight: '600',
  },

  // ── COMPETITION OVERLAY (during run) ──────────────────
  competitionCard: {
    width: '100%',
    marginTop: 10,
    backgroundColor: '#0A84FF15',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#0A84FF40',
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
    backgroundColor: '#0A84FF',
    marginRight: 8,
  },
  competitionTitle: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    color: '#0A84FF',
    letterSpacing: 1,
  },
  competitionLead: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'monospace',
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
    color: '#FFFFFF',
    fontFamily: 'monospace',
  },
  competitionStatLabel: {
    fontSize: 9,
    color: '#8E8E93',
    marginTop: 2,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  competitionDivider: {
    width: 1,
    height: 28,
    backgroundColor: '#38383A',
  },
  competitionNpiRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#38383A',
  },
  competitionNpiLabel: {
    fontSize: 11,
    color: '#8E8E93',
    fontWeight: '500',
  },
  competitionNpiValue: {
    fontSize: 13,
    fontWeight: '700',
  },

  // ── RUNNING ───────────────────────────────────────────
  runContainer: {
    flex: 1,
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
    backgroundColor: 'rgba(255, 59, 48, 0.15)',
    borderRadius: 20,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#FF3B30',
  },
  liveText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#FF3B30',
    letterSpacing: 2,
  },
  gpsCount: { fontSize: 10, color: '#8E8E93', marginLeft: 4 },

  recenterBtn: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(28, 28, 30, 0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recenterIcon: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },

  ghostOverlay: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(28, 28, 30, 0.9)',
    borderRadius: 16,
  },
  ghostOverlayLabel: {
    fontSize: 10, fontWeight: '700', color: '#8E8E93', letterSpacing: 1,
  },
  ghostOverlayText: { fontSize: 12, fontWeight: '700', fontFamily: 'monospace' },

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
    backgroundColor: 'rgba(0, 255, 135, 0.3)',
  },
  runnerMarkerDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#00FF87',
    borderWidth: 3,
    borderColor: '#fff',
  },
  ghostMarker: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 59, 48, 0.2)',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 59, 48, 0.5)',
  },
  ghostMarkerInner: {
    flexDirection: 'row',
    gap: 4,
  },
  ghostEye: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#FF3B30',
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
    backgroundColor: '#00FF87',
    borderWidth: 2,
    borderColor: '#FFFFFF',
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
    backgroundColor: '#FFD60A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  finishMarkerDotInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#000000',
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
    color: '#FFFFFF',
    fontFamily:
      Platform.OS === 'ios' ? 'Helvetica Neue' : 'sans-serif-condensed',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
  },
  mainStatUnit: {
    fontSize: 22,
    fontWeight: '400',
    color: '#636366',
    marginLeft: 4,
  },

  // Live stats row
  liveStats: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    backgroundColor: 'rgba(28, 28, 30, 0.85)',
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 8,
    width: '100%',
    borderWidth: 1,
    borderColor: '#38383A',
  },
  liveStatItem: { flex: 1, alignItems: 'center' },
  liveStatValue: {
    fontSize: 22,
    fontWeight: '600',
    color: '#FFFFFF',
    fontFamily: 'monospace',
  },
  liveStatLabel: {
    fontSize: 9,
    color: '#636366',
    marginTop: 4,
    fontWeight: '600',
    letterSpacing: 1,
  },
  divider: { width: 1, height: 36, backgroundColor: '#38383A' },

  // Live RII
  liveRIIBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    marginTop: 10,
    backgroundColor: '#1C1C1E',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  liveRIILeft: {},
  liveRIILabel: {
    fontSize: 10, color: '#8E8E93', fontWeight: '600', letterSpacing: 1,
  },
  liveRIIValue: { fontSize: 16, fontWeight: '700', fontFamily: 'monospace', marginTop: 2 },
  ghostLeadBadge: { fontSize: 14, fontWeight: '700', fontFamily: 'monospace' },

  // Splits
  splitsContainer: {
    width: '100%',
    backgroundColor: '#1C1C1E',
    borderRadius: 12,
    padding: 16,
    marginTop: 10,
  },
  splitsTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: '#8E8E93',
    marginBottom: 8,
    letterSpacing: 1.5,
  },
  splitRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  splitKm: { fontSize: 13, color: '#8E8E93' },
  splitPace: {
    fontSize: 13,
    color: '#00FF87',
    fontFamily: 'monospace',
    fontWeight: '600',
  },

  // GPS indicator
  gpsIndicator: {
    marginTop: 10,
    alignItems: 'center',
  },
  gpsLabel: { fontSize: 10, color: '#636366', fontFamily: 'monospace' },
  gpsAccuracy: { fontSize: 10, color: '#0A84FF', marginTop: 2 },

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
    backgroundColor: 'rgba(28, 28, 30, 0.9)',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#0A84FF40',
    zIndex: 10,
  },
  peerMapOverlayLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#0A84FF',
    letterSpacing: 1,
    marginBottom: 2,
  },
  peerMapOverlayText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
    color: '#FFFFFF',
  },

  stopButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(255,59,48,0.85)',
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#FF3B30',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
    elevation: 8,
  },
  stopInner: {
    width: 28,
    height: 28,
    backgroundColor: '#FFFFFF',
    borderRadius: 4,
  },
  stopLabelOverlay: {
    marginTop: 12,
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 2,
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },

  // ── FINISHED ──────────────────────────────────────────
  finishedScroll: {
    flex: 1,
    backgroundColor: '#000000',
  },
  finishedContent: {
    paddingHorizontal: 16,
    paddingTop: 0,
    paddingBottom: 40,
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
    backgroundColor: 'rgba(28, 28, 30, 0.9)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  finishedMapBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#00FF87',
    letterSpacing: 1,
  },
  finishHeader: {
    alignItems: 'center',
    marginBottom: 12,
  },
  finishTitle: {
    fontSize: 28,
    fontWeight: '300',
    color: '#FFFFFF',
    letterSpacing: 1,
  },
  summaryCard: {
    width: '100%',
    backgroundColor: '#1C1C1E',
    borderRadius: 16,
    padding: 24,
    marginBottom: 12,
  },
  summaryRow: { flexDirection: 'row' },
  summaryItem: { flex: 1, alignItems: 'center' },
  summaryValue: {
    fontSize: 28,
    fontWeight: '700',
    color: '#FFFFFF',
    fontFamily: 'monospace',
  },
  summaryLabel: {
    fontSize: 10, color: '#636366', marginTop: 4,
    fontWeight: '600', letterSpacing: 1,
  },

  // RII Result
  riiResultCard: {
    width: '100%',
    backgroundColor: '#1C1C1E',
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#00FF8730',
  },
  riiResultLabel: {
    fontSize: 10, color: '#8E8E93', fontWeight: '600', letterSpacing: 2,
  },
  riiResultValue: {
    fontSize: 48,
    fontWeight: '200',
    fontFamily: 'monospace',
    marginVertical: 4,
  },
  riiResultDesc: { fontSize: 12, color: '#636366', marginTop: 4 },

  // GPS Stats
  gpsStatsCard: {
    width: '100%',
    backgroundColor: '#1C1C1E',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  gpsStatsTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: '#8E8E93',
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
    color: '#FFFFFF',
    fontFamily: 'monospace',
  },
  gpsStatLabel: {
    fontSize: 10,
    color: '#636366',
    marginTop: 2,
    fontWeight: '600',
    letterSpacing: 0.5,
  },

  // Reset
  resetButton: {
    marginTop: 8,
    paddingHorizontal: 32,
    paddingVertical: 14,
    backgroundColor: '#00FF87',
    borderRadius: 12,
    alignSelf: 'center',
  },
  resetButtonText: {
    fontSize: 14, fontWeight: '700', color: '#000000', letterSpacing: 1,
  },
});
