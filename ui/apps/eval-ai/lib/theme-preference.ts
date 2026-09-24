export type ColorMode = "system" | "light" | "dark";
export type ResolvedColorMode = "light" | "dark";

export const THEME_COOKIE = "proofgrove.theme";
export const THEME_SETTINGS_KEY = "proofgrove.settings";

const COLOR_MODES: readonly ColorMode[] = ["system", "light", "dark"];

export function parseColorMode(value: unknown): ColorMode {
  return typeof value === "string" &&
    (COLOR_MODES as readonly string[]).includes(value)
    ? (value as ColorMode)
    : "light";
}

export function resolveColorMode(
  mode: ColorMode,
  systemPrefersDark: boolean,
): ResolvedColorMode {
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  return systemPrefersDark ? "dark" : "light";
}

export function loadColorMode(): ColorMode {
  if (typeof window === "undefined") return "light";
  try {
    const raw = window.localStorage.getItem(THEME_SETTINGS_KEY);
    if (!raw) return "light";
    const settings = JSON.parse(raw) as { colorMode?: unknown };
    return parseColorMode(settings.colorMode);
  } catch {
    return "light";
  }
}

export function saveColorMode(mode: ColorMode): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(THEME_SETTINGS_KEY);
    const current = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    window.localStorage.setItem(
      THEME_SETTINGS_KEY,
      JSON.stringify({ ...current, colorMode: parseColorMode(mode) }),
    );
  } catch {
    // The live preference still applies when storage is unavailable.
  }
}
