/**
 * Live NPI tab on the right edge of the run map, vertically centred.
 * Collapsed it shows the current NPI; swipe it left (or tap) and the worked
 * calculation slides out over the map; swipe right (or tap the tab) to put
 * it away. Same numbers as the score (NpiBreakdownBody / calculateNPI).
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  View,
  useWindowDimensions,
} from 'react-native';
import { calculateNPI, formatNPI } from '../core/npiEngine';
import { NpiBreakdownBody, type NpiData } from './NpiBreakdownSheet';
import { Icon } from './ui';
import { colors } from '../theme/tokens';

const TAB_W = 64;
const DEFAULT_ALTITUDE_M = 15;

export default function NpiSidePanel(data: NpiData) {
  const { width } = useWindowDimensions();
  const panelW = Math.min(width - TAB_W - 8, 380);
  const [open, setOpen] = useState(false);
  // 0 = open (panel on screen), panelW = closed (only the tab shows)
  const x = useRef(new Animated.Value(panelW)).current;
  const xNow = useRef(panelW);
  const startX = useRef(panelW);

  const settle = useCallback(
    (toOpen: boolean) => {
      setOpen(toOpen);
      const to = toOpen ? 0 : panelW;
      xNow.current = to;
      Animated.spring(x, { toValue: to, useNativeDriver: true, bounciness: 4, speed: 14 }).start();
    },
    [panelW, x],
  );

  const pan = useMemo(
    () =>
      PanResponder.create({
        // horizontal drags only; vertical ones scroll the calculation
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderGrant: () => {
          x.stopAnimation(v => {
            startX.current = v;
          });
        },
        onPanResponderMove: (_e, g) => {
          const v = Math.max(0, Math.min(panelW, startX.current + g.dx));
          xNow.current = v;
          x.setValue(v);
        },
        onPanResponderRelease: (_e, g) => {
          const toOpen = g.vx < -0.3 ? true : g.vx > 0.3 ? false : xNow.current < panelW / 2;
          settle(toOpen);
        },
        onPanResponderTerminate: () => settle(xNow.current < panelW / 2),
      }),
    [panelW, settle, x],
  );

  const { runner, altitudeM, distanceM, avgPaceSPerKm } = data;
  const hasPace = avgPaceSPerKm !== null && avgPaceSPerKm > 0 && isFinite(avgPaceSPerKm);
  const npi =
    runner && hasPace
      ? calculateNPI(
          { age: runner.age, bmi: runner.bmi, gender: runner.gender },
          { altitudeM: altitudeM ?? DEFAULT_ALTITUDE_M, distanceM, avgPaceSPerKm: avgPaceSPerKm! },
        ).npi
      : null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.wrap, { width: panelW + TAB_W, transform: [{ translateX: x }] }]}
      {...pan.panHandlers}
    >
      {/* Tab: live NPI, vertically centred on the map's right edge */}
      <TouchableWithoutFeedback
        onPress={() => settle(!open)}
        accessibilityRole="button"
        accessibilityLabel={open ? 'Hide NPI calculation' : 'Show NPI calculation'}
      >
        <View style={styles.tab}>
          <Icon name={open ? 'chevron-forward' : 'chevron-back'} size={14} color={colors.textDim} />
          <Text style={styles.tabLabel}>NPI</Text>
          <Text style={styles.tabValue} numberOfLines={1} adjustsFontSizeToFit>
            {npi !== null ? formatNPI(npi) : '—'}
          </Text>
        </View>
      </TouchableWithoutFeedback>

      {/* Panel: the worked calculation */}
      <View style={[styles.panel, { width: panelW }]}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 6 }}>
          <NpiBreakdownBody active={open} compact {...data} />
        </ScrollView>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    right: 0,
    top: 64, // below the RECORDING label and the status bar
    bottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 20,
  },
  tab: {
    width: TAB_W,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: colors.overlay,
    borderTopLeftRadius: 18,
    borderBottomLeftRadius: 18,
    borderWidth: 1,
    borderRightWidth: 0,
    borderColor: colors.border,
  },
  tabLabel: { fontFamily: 'Urbanist_700Bold', fontSize: 11, letterSpacing: 1.2, color: colors.npi, marginTop: 2 },
  tabValue: { fontFamily: 'Urbanist_800ExtraBold', fontSize: 18, color: colors.text, marginTop: 2, paddingHorizontal: 4 },
  panel: {
    maxHeight: '100%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: 22,
    borderBottomLeftRadius: 22,
    borderWidth: 1,
    borderRightWidth: 0,
    borderColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
});
