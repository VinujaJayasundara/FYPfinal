/**
 * Stand-in for the map on builds without the MapLibre native module
 * (an older development build). Same exports as MapLibreMaps.tsx.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme/tokens';

function Placeholder() {
  return (
    <View style={[StyleSheet.absoluteFill, styles.box]}>
      <Text style={styles.text}>Map available after the app update</Text>
    </View>
  );
}

export const darkMapStyle: any[] = [];
export const IdleMap = (_: { region: unknown }) => <Placeholder />;
export const RunningMap = (_: Record<string, unknown>) => <Placeholder />;
export const FinishedMap = (_: Record<string, unknown>) => <Placeholder />;
export function animateMapToRegion(_mapRef: unknown, _region: unknown, _duration?: number) {}
export function fitMapToCoordinates(_mapRef: unknown, _coords: unknown) {}

const styles = StyleSheet.create({
  box: { backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 40 },
  text: { fontFamily: 'Urbanist_400Regular', color: colors.textFaint, fontSize: 12 },
});
