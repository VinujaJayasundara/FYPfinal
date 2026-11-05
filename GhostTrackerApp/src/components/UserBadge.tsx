/**
 * UserBadge — Top-left user avatar + name (Touchable)
 * =====================================================
 * Displays the user's initials in a circle avatar and their name.
 * Tapping it navigates to the profile screen.
 * Reads from ProfileContext so it stays in sync with profile edits.
 */

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useProfile } from '../context/ProfileContext';
import Avatar from './Avatar';
import { colors } from '../theme/tokens';

// ── Design Tokens ─────────────────────────────────────────
const C = {
  accent: colors.accent,
  accentDim: colors.accent + '18',
  textPrimary: colors.text,
  textSecondary: colors.textDim,
};

interface UserBadgeProps {
  /** Called when the user taps the badge — navigates to Profile */
  onPress?: () => void;
}

export default function UserBadge({ onPress }: UserBadgeProps) {
  const { profile } = useProfile();

  return (
    <TouchableOpacity
      style={styles.container}
      onPress={onPress}
      activeOpacity={0.7}
    >
      {/* Avatar ring with initials */}
      <View style={styles.avatarRing}>
        <Avatar name={profile.name} uri={profile.avatarUri} size={28} />
      </View>
      {/* Name + subtitle */}
      <View style={styles.textContainer}>
        <Text style={styles.name} numberOfLines={1}>
          {profile.name}
        </Text>
        <Text style={styles.subtitle}>View Profile</Text>
      </View>
    </TouchableOpacity>
  );
}

// ── Styles ────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 2,
    paddingRight: 8,
  },
  avatarRing: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1.5,
    borderColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 2,
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: C.accentDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 11,
    fontFamily: 'Urbanist_800ExtraBold',
    color: C.accent,
    letterSpacing: 0.5,
  },
  textContainer: {
    justifyContent: 'center',
  },
  name: {
    fontSize: 13,
    fontFamily: 'Urbanist_600SemiBold',
    color: C.textPrimary,
    maxWidth: 90,
    lineHeight: 16,
  },
  subtitle: {
    fontSize: 9,
    fontFamily: 'Urbanist_500Medium',
    color: C.textSecondary,
    letterSpacing: 0.3,
    lineHeight: 12,
  },
});
