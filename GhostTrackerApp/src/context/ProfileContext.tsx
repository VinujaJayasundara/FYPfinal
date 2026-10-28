/**
 * ProfileContext — User Profile State
 * =====================================
 * Stores the current user's name and physical profile data.
 * Used by UserBadge (display) and ProfileSetupScreen (edit).
 * Persists to SQLite via the database layer.
 * Defaults to "Vinuja" to match existing mock data.
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
} from '../data/database';

// ── Types ─────────────────────────────────────────────────

export interface UserProfile {
  name: string;
  age: number;
  weightKg: number;
  heightCm: number;
  gender: 'M' | 'F';
  bmi: number;
  deviceId: string;
}

interface ProfileContextValue {
  profile: UserProfile;
  setProfile: (updates: Partial<UserProfile>) => void;
  updateFromSetup: (name: string, age: number, weightKg: number, heightCm: number, gender: 'M' | 'F') => void;
}

// ── Default profile ───────────────────────────────────────

const DEFAULT_PROFILE: UserProfile = {
  name: 'Vinuja',
  age: 22,
  weightKg: 68,
  heightCm: 175,
  gender: 'M',
  bmi: calculateBMI(68, 175),
  deviceId: '',
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
          });
          console.log('[Profile] Loaded from DB');
        } else {
          _setProfile(prev => ({
            ...prev,
            name: device.userAlias,
            deviceId: device.deviceId,
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

  return (
    <ProfileContext.Provider value={{ profile, setProfile, updateFromSetup }}>
      {children}
    </ProfileContext.Provider>
  );
}

