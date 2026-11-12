import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';

import { darkColors, lightColors, Palette } from './colors';

export type ThemePreference = 'system' | 'light' | 'dark';

/** Options in the order they appear in the theme dialog. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

const STORAGE_KEY = 'theme_preference';

interface ThemeContextValue {
  colors: Palette;
  isDark: boolean;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Stores the user's theme choice (system / light / dark) and provides the matching palette. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((saved) => {
        if (saved && (THEME_PREFERENCES as string[]).includes(saved)) {
          setPreferenceState(saved as ThemePreference);
        }
      })
      .catch(() => undefined);
  }, []);

  const value = useMemo<ThemeContextValue>(() => {
    const isDark = preference === 'system' ? systemScheme === 'dark' : preference === 'dark';
    return {
      colors: isDark ? darkColors : lightColors,
      isDark,
      preference,
      setPreference: (next) => {
        setPreferenceState(next);
        AsyncStorage.setItem(STORAGE_KEY, next).catch(() => undefined);
      },
    };
  }, [preference, systemScheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('useTheme must be used inside ThemeProvider');
  return theme;
}
