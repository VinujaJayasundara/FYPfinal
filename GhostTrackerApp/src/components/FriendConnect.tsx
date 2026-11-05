/**
 * "Connect with a friend" — Run screen entry point for Bluetooth sync.
 *
 * Always shown (on builds with Bluetooth). Tapping it first asks for the
 * Nearby-devices permission and checks Bluetooth is on (offering the
 * Bluetooth settings if not). Opening it then starts the Bluetooth
 * service and lists nearby runners by name. Tapping Invite sends an
 * invitation; the friend sees an Accept / Decline dialog. Leaderboards sync
 * only after both have agreed.
 */

import React, { useState } from 'react';
import { ActivityIndicator, Alert, Linking, Modal, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useBluetooth } from '../context/BluetoothContext';
import { useRace, RACE_COLOR, RACE_SYMBOL } from '../context/RaceContext';
import { RaceDistancePicker } from './RaceUI';
import type { BlePeer } from '../core/BluetoothSync';
import { colors } from '../theme/tokens';
import { Button, glassFill } from './ui';

const C = {
  surface: colors.surface,
  elevated: colors.elevated,
  separator: colors.border,
  accent: colors.accent,
  amber: colors.textDim,
  blue: colors.peer,
  red: colors.danger,
  muted: colors.textDim,
};

export function FriendConnectButton() {
  const bt = useBluetooth();
  const [open, setOpen] = useState(false);

  if (!bt.available) return null;

  const paired = bt.peers.filter(p => p.pairing === 'paired');
  const label =
    paired.length > 0
      ? `Connected with ${paired.map(p => p.alias ?? 'friend').join(', ')}`
      : 'Connect with a friend · sync or race';

  const openPanel = async () => {
    const ready = await bt.prepare();
    if (ready === 'denied') {
      Alert.alert(
        'Allow Nearby devices',
        'To find and connect with a friend, allow the "Nearby devices" (Bluetooth) permission for Ghost Tracker. No location is shared.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open settings', onPress: () => Linking.openSettings() },
        ],
      );
      return;
    }
    if (ready === 'off') {
      Alert.alert('Turn on Bluetooth', 'Bluetooth is off. Turn it on to connect with a friend.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Bluetooth settings',
          onPress: () =>
            Platform.OS === 'android'
              ? Linking.sendIntent('android.settings.BLUETOOTH_SETTINGS').catch(() => Linking.openSettings())
              : Linking.openSettings(),
        },
      ]);
      return;
    }
    setOpen(true);
    if (!bt.running) await bt.start();
  };

  return (
    <>
      <TouchableOpacity
        style={[styles.button, paired.length > 0 && styles.buttonPaired]}
        onPress={openPanel}
        accessibilityRole="button"
      >
        <Text style={[styles.buttonText, paired.length > 0 && { color: C.accent }]} numberOfLines={1}>
          {label}
        </Text>
        {paired.length > 0 ? (
          <Text style={styles.buttonSub}>{bt.gossipStatus}</Text>
        ) : bt.adapterOn !== true ? (
          <Text style={styles.buttonSub}>Bluetooth is off · tap to turn on</Text>
        ) : null}
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <Text style={styles.title}>Connect with a friend</Text>
            <Text style={styles.sub}>
              Your friend also taps “Connect with a friend”. Invite them, and once they accept, your leaderboards sync over
              Bluetooth.
            </Text>

            {bt.starting && (
              <View style={styles.row}>
                <ActivityIndicator color={C.accent} />
                <Text style={[styles.sub, { marginLeft: 10, marginBottom: 0 }]}>Starting Bluetooth…</Text>
              </View>
            )}

            {bt.running && bt.peers.length === 0 && (
              <View style={styles.row}>
                <ActivityIndicator color={C.muted} />
                <Text style={[styles.sub, { marginLeft: 10, marginBottom: 0 }]}>Looking for nearby runners…</Text>
              </View>
            )}

            {bt.peers.map((peer, i) => (
              <PeerRow key={peer.tag} peer={peer} first={i === 0} onRaceSet={() => setOpen(false)} />
            ))}

            <View style={styles.footer}>
              {bt.running && (
                <Button
                  label="Turn off sync"
                  variant="danger"
                  size="sm"
                  style={styles.footerBtn}
                  onPress={async () => {
                    await bt.stop();
                    setOpen(false);
                  }}
                />
              )}
              <Button label="Done" variant="secondary" size="sm" style={styles.footerBtn} onPress={() => setOpen(false)} />
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

function PeerRow({ peer, first, onRaceSet }: { peer: BlePeer; first: boolean; onRaceSet: () => void }) {
  const bt = useBluetooth();
  const { race, startRace } = useRace();
  const [picking, setPicking] = useState(false);
  const name = peer.alias ?? 'Nearby runner';
  const raceBusy = race !== null && race.phase !== 'done' && race.phase !== 'cancelled';
  const ready = peer.status === 'connected' && peer.deviceId !== null;

  let action: React.ReactNode;
  if (peer.pairing === 'paired') {
    action = (
      <Button label="Connected" icon="checkmark" variant="secondary" size="sm" onPress={() => bt.unpair(peer.deviceId!)} />
    );
  } else if (peer.pairing === 'invited-out') {
    action = <Text style={[styles.actionText, { color: C.muted }]}>Waiting for {name}…</Text>;
  } else if (peer.pairing === 'invited-in') {
    action = (
      <Button label="Accept" size="sm" onPress={() => bt.accept(peer.deviceId!)} />
    );
  } else if (ready) {
    action = (
      <Button label="Invite" size="sm" onPress={() => bt.invite(peer.deviceId!)} />
    );
  } else {
    action = <Text style={[styles.actionText, { color: C.muted }]}>Connecting…</Text>;
  }

  return (
    <View style={[!first && styles.peerBorder]}>
      <View style={styles.peer}>
        <View style={{ flex: 1 }}>
          <Text style={styles.peerName}>{name}</Text>
          <Text style={styles.peerMeta}>
            {peer.rssi !== null ? `Signal ${peer.rssi} dBm` : 'Signal --'}
            {peer.pairing === 'paired' ? ' · tap Connected to disconnect' : ''}
          </Text>
        </View>
        {peer.pairing === 'paired' && !raceBusy && (
          <Button label="Race" icon="flag-outline" variant="secondary" size="sm" style={{ marginRight: 8 }} onPress={() => setPicking(p => !p)} />
        )}
        {action}
      </View>
      {picking && peer.pairing === 'paired' && !raceBusy && (
        <View style={{ paddingBottom: 12 }}>
          <Text style={styles.peerMeta}>Pick the race distance; {name} sees it before starting.</Text>
          <RaceDistancePicker
            onPick={m => {
              if (peer.deviceId && startRace(peer.deviceId, name, m)) {
                setPicking(false);
                onRaceSet();
              }
            }}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    alignSelf: 'stretch',
    paddingVertical: 16,
    paddingHorizontal: 18,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    backgroundColor: colors.overlay,
    alignItems: 'center',
  },
  buttonPaired: { ...glassFill('green'), backgroundColor: colors.glass, borderColor: colors.hairline },
  buttonText: { color: colors.text, fontSize: 15, fontFamily: 'Urbanist_700Bold', letterSpacing: 0.5 },
  buttonSub: { fontFamily: 'Urbanist_400Regular', color: C.muted, fontSize: 12, marginTop: 4 },
  overlay: { flex: 1, backgroundColor: colors.bg + 'AA', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: C.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 20,
    paddingBottom: 32,
  },
  title: { color: colors.text, fontSize: 20, fontFamily: 'Urbanist_800ExtraBold', marginBottom: 6 },
  sub: { fontFamily: 'Urbanist_400Regular', color: C.muted, fontSize: 13, lineHeight: 18, marginBottom: 14 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  peer: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  peerBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.separator },
  peerName: { color: colors.text, fontSize: 16, fontFamily: 'Urbanist_700Bold' },
  peerMeta: { fontFamily: 'Urbanist_400Regular', color: C.muted, fontSize: 12, marginTop: 2 },
  actionText: { fontSize: 13, fontFamily: 'Urbanist_700Bold' },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 18 },
  footerBtn: { marginLeft: 10 },
});
