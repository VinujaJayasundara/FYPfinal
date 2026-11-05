/**
 * Avatar — the profile picture, or the runner's initials when there is none
 * (or the file cannot be loaded).
 */

import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors } from '../theme/tokens';

export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map(w => w.charAt(0).toUpperCase()).join('') || '?';
}

export default function Avatar({
  name,
  uri,
  size,
  style,
}: {
  name: string;
  uri: string | null | undefined;
  size: number;
  style?: StyleProp<ViewStyle>;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri]);

  const circle = { width: size, height: size, borderRadius: size / 2 };
  return (
    <View style={[styles.base, circle, style]}>
      {uri && !failed ? (
        <Image source={{ uri }} style={circle} onError={() => setFailed(true)} />
      ) : (
        <Text style={[styles.initials, { fontSize: size * 0.38 }]}>{getInitials(name)}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  base: { backgroundColor: colors.accent + '18', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  initials: { color: colors.accent, fontWeight: '800', letterSpacing: 0.5 },
});
