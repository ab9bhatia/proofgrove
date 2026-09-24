"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import {
  loadColorMode,
  resolveColorMode,
  saveColorMode,
  THEME_COOKIE,
  type ColorMode,
  type ResolvedColorMode,
} from "@/lib/theme-preference";

interface ThemeValue {
  colorMode: ColorMode;
  resolvedColorMode: ResolvedColorMode;
  setColorMode: (mode: ColorMode) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);
const PREFERS_DARK = "(prefers-color-scheme: dark)";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function subscribeToSystemTheme(onStoreChange: () => void) {
  const query = window.matchMedia(PREFERS_DARK);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

function getSystemPrefersDark() {
  return window.matchMedia(PREFERS_DARK).matches;
}

function applyResolvedMode(mode: ResolvedColorMode) {
  const dark = mode === "dark";
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = mode;
  document.cookie = `${THEME_COOKIE}=${mode}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
}

export function ThemeProvider({
  initialResolvedMode,
  children,
}: {
  initialResolvedMode: ResolvedColorMode;
  children: React.ReactNode;
}) {
  const [colorMode, setColorModeState] = useState<ColorMode>(initialResolvedMode);
  const systemPrefersDark = useSyncExternalStore(
    subscribeToSystemTheme,
    getSystemPrefersDark,
    () => initialResolvedMode === "dark",
  );

  const resolvedColorMode = useMemo(
    () => resolveColorMode(colorMode, systemPrefersDark),
    [colorMode, systemPrefersDark],
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setColorModeState(loadColorMode());
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    applyResolvedMode(resolvedColorMode);
  }, [resolvedColorMode]);

  const setColorMode = useCallback((mode: ColorMode) => {
    setColorModeState(mode);
    saveColorMode(mode);
  }, []);

  const value = useMemo(
    () => ({ colorMode, resolvedColorMode, setColorMode }),
    [colorMode, resolvedColorMode, setColorMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}
