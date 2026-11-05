/**
 * ProfileContext — User Profile State
 * =====================================
 * Stores the current user's name and physical profile data.
 * Used by UserBadge (display) and ProfileSetupScreen (edit).
 * Persists to SQLite via the database layer.
 * New installs start as "Runner" until the user sets a name.
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import { calculateBMI } from '../core/npiEngine';
import {
  saveUserProfile,
  getUserProfile,
  getOrCreateDeviceProfile,
  updateDeviceProfileAlias,
  getAvatarUri,
  setAvatarUri,
} from '../data/database';
import { deleteAvatarFile } from '../core/avatar';

// ── Types ─────────────────────────────────────────────────

export interface UserProfile {
  name: string;
  age: number;
  weightKg: number;
  heightCm: number;
  gender: 'M' | 'F';
  bmi: number;
  deviceId: string;
  /** Profile picture on this phone (null = show initials). */
  avatarUri: string | null;
  /**
   * Age/height/weight/sex have been saved by the user. Until then the
   * numbers above are placeholders and no NPI can be calculated.
   */
  physicalSaved: boolean;
}

interface ProfileContextValue {
  profile: UserProfile;
  setProfile: (updates: Partial<UserProfile>) => void;
  updateFromSetup: (name: string, age: number, weightKg: number, heightCm: number, gender: 'M' | 'F') => void;
  /** Store a new picture (already copied into app storage) or remove it (null). */
  setAvatar: (uri: string | null) => Promise<void>;
}

// ── Default profile ───────────────────────────────────────

const DEFAULT_PROFILE: UserProfile = {
  name: 'Runner',
  age: 22,
  weightKg: 68,
  heightCm: 175,
  gender: 'M',
  bmi: calculateBMI(68, 175),
  deviceId: '',
  avatarUri: null,
  physicalSaved: false,
};

// ── Context ───────────────────────────────────────────────

const ProfileContext = createContext<ProfileContextValue | null>(null);

/**
 * Hook to consume profile state from any component.
 */
export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile must be used within <ProfileProvider>');
  return ctx;
}

// ── Provider ──────────────────────────────────────────────

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [profile, _setProfile] = useState<UserProfile>(DEFAULT_PROFILE);

  // Load profile from SQLite on mount
  useEffect(() => {
    (async () => {
      try {
        const device = await getOrCreateDeviceProfile(DEFAULT_PROFILE.name);
        console.log('[Profile] Device:', device.deviceId);
        // Bring our own leaderboard entries in line with the current name
        // (entries saved before a rename keep the old alias otherwise).
        await updateDeviceProfileAlias(device.userAlias);

        const avatarUri = await getAvatarUri().catch(() => null);
        const dbProfile = await getUserProfile();
        if (dbProfile) {
          _setProfile({
            name: device.userAlias,
            age: dbProfile.age,
            weightKg: dbProfile.weight_kg,
            heightCm: dbProfile.height_cm,
            gender: dbProfile.gender as 'M' | 'F',
            bmi: dbProfile.bmi,
            deviceId: device.deviceId,
            avatarUri,
            physicalSaved: true,
          });
          console.log('[Profile] Loaded from DB');
        } else {
          _setProfile(prev => ({
            ...prev,
            name: device.userAlias,
            deviceId: device.deviceId,
            avatarUri,
          }));
        }
      } catch (e) {
        console.error('[Profile] Failed to load from DB:', e);
      }
    })();
  }, []);

  // Merge partial updates into the existing profile
  const setProfile = useCallback((updates: Partial<UserProfile>) => {
    _setProfile((prev) => ({ ...prev, ...updates }));
  }, []);

  // Convenience method called from ProfileSetupScreen — saves to DB
  const updateFromSetup = useCallback(
    (name: string, age: number, weightKg: number, heightCm: number, gender: 'M' | 'F') => {
      const bmi = calculateBMI(weightKg, heightCm);
      _setProfile((prev) => ({
        ...prev,
        name,
        age,
        weightKg,
        heightCm,
        gender,
        bmi,
        physicalSaved: true,
      }));

      // Persist to SQLite (fire & forget)
      Promise.all([
        saveUserProfile(age, weightKg, heightCm, gender),
        updateDeviceProfileAlias(name)
      ])
        .then(() => console.log('[Profile] Saved name and profile to DB'))
        .catch((e) => console.error('[Profile] Save failed:', e));
    },
    [],
  );

  const avatarRef = React.useRef<string | null>(null);
  avatarRef.current = profile.avatarUri;
  const setAvatar = useCallback(async (uri: string | null) => {
    const previous = avatarRef.current;
    await setAvatarUri(uri);
    _setProfile(prev => ({ ...prev, avatarUri: uri }));
    if (previous && previous !== uri) deleteAvatarFile(previous);
  }, []);

  return (
    <ProfileContext.Provider value={{ profile, setProfile, updateFromSetup, setAvatar }}>
      {children}
    </ProfileContext.Provider>
  );
}

