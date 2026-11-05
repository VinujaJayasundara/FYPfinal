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

const C = {
  surface: '#1C1C1E',
  elevated: '#2C2C2E',
  separator: '#38383A',
  accent: '#00FF87',
  amber: '#FF9F0A',
  blue: '#0A84FF',
  red: '#FF3B30',
  muted: '#8E8E93',
};

export function FriendConnectButton() {
  const bt = useBluetooth();
  const [open, setOpen] = useState(false);

  if (!bt.available) return null;

  const paired = bt.peers.filter(p => p.pairing === 'paired');
  const label =
    paired.length > 0
      ? `👥 Connected with ${paired.map(p => p.alias ?? 'friend').join(', ')}`
      : '👥 CONNECT WITH A FRIEND';

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
                <TouchableOpacity
                  style={[styles.footerBtn, { borderColor: C.red }]}
                  onPress={async () => {
                    await bt.stop();
                    setOpen(false);
                  }}
                >
                  <Text style={[styles.footerText, { color: C.red }]}>Turn off sync</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.footerBtn} onPress={() => setOpen(false)}>
                <Text style={styles.footerText}>Done</Text>
              </TouchableOpacity>
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
      <TouchableOpacity style={[styles.action, { borderColor: C.accent }]} onPress={() => bt.unpair(peer.deviceId!)}>
        <Text style={[styles.actionText, { color: C.accent }]}>Connected ✓</Text>
      </TouchableOpacity>
    );
  } else if (peer.pairing === 'invited-out') {
    action = <Text style={[styles.actionText, { color: C.amber }]}>Waiting for {name}…</Text>;
  } else if (peer.pairing === 'invited-in') {
    action = (
      <TouchableOpacity style={[styles.action, styles.actionFilled]} onPress={() => bt.accept(peer.deviceId!)}>
        <Text style={[styles.actionText, { color: '#000' }]}>Accept</Text>
      </TouchableOpacity>
    );
  } else if (ready) {
    action = (
      <TouchableOpacity style={[styles.action, { borderColor: C.blue }]} onPress={() => bt.invite(peer.deviceId!)}>
        <Text style={[styles.actionText, { color: C.blue }]}>Invite</Text>
      </TouchableOpacity>
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
          <TouchableOpacity
            style={[styles.action, { borderColor: RACE_COLOR, marginRight: 8 }]}
            onPress={() => setPicking(p => !p)}
          >
            <Text style={[styles.actionText, { color: RACE_COLOR }]}>{RACE_SYMBOL} Race</Text>
          </TouchableOpacity>
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
    marginTop: 14,
    alignSelf: 'stretch',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.separator,
    backgroundColor: '#1C1C1ECC',
    alignItems: 'center',
  },
  buttonPaired: { borderColor: '#00FF8770' },
  buttonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700', letterSpacing: 1 },
  buttonSub: { color: C.muted, fontSize: 12, marginTop: 4 },
  overlay: { flex: 1, backgroundColor: '#000000AA', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: C.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 32,
  },
  title: { color: '#FFFFFF', fontSize: 20, fontWeight: '800', marginBottom: 6 },
  sub: { color: C.muted, fontSize: 13, lineHeight: 18, marginBottom: 14 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  peer: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  peerBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.separator },
  peerName: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  peerMeta: { color: C.muted, fontSize: 12, marginTop: 2 },
  action: { borderWidth: 1, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 14 },
  actionFilled: { backgroundColor: C.accent, borderColor: C.accent },
  actionText: { fontSize: 13, fontWeight: '700' },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 18 },
  footerBtn: {
    borderWidth: 1,
    borderColor: C.separator,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 18,
    marginLeft: 10,
  },
  footerText: { color: '#FFFFFF', fontWeight: '700' },
});
