import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Rgb = [number, number, number];
type Theme = Record<string, Rgb>;
type ContrastPair = [string, (theme: Theme, isDark: boolean) => [Rgb, Rgb]];

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

function block(selector: string): string {
  const body = css.match(new RegExp(`${selector}\\s*\\{([^}]+)\\}`))?.[1];
  if (!body) throw new Error(`Missing ${selector} token block`);
  return body;
}

function color(value: string): Rgb {
  const hex = value.match(/^#([\da-f]{6})$/i)?.[1];
  if (hex) return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)) as Rgb;
  const rgb = value.match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*[\d.]+)?\s*\)$/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  throw new Error(`Unsupported color: ${value}`);
}

function tokens(selector: string, base: Theme = {}): Theme {
  const theme = { ...base };
  for (const match of block(selector).matchAll(/--([\w-]+):\s*(#[\da-f]{6}|rgb\([^;]+\))/gi)) {
    theme[match[1]] = color(match[2]);
  }
  return theme;
}

function tokenAlpha(selector: string, name: string): number {
  const alpha = block(selector).match(new RegExp(`--${name}:\\s*rgb\\([^/]+/\\s*([\\d.]+)\\s*\\)`))?.[1];
  if (!alpha) throw new Error(`Missing alpha channel for --${name} in ${selector}`);
  return Number(alpha);
}

function mix(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  return foreground.map((channel, index) => channel * alpha + background[index] * (1 - alpha)) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [red, green, blue] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

export function contrast(foreground: Rgb, background: Rgb): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const light = tokens(":root");
const dark = tokens("\\.dark", light);
const sidebar = tokens("\\.brand-sidebar", light);
const darkSidebar = tokens("\\.dark \\.brand-sidebar", { ...dark, ...sidebar });

const gatePairs = (["pass", "warn", "fail", "neutral"] as const).flatMap((gate): ContrastPair[] => [
  [`gate ${gate} / card`, (theme: Theme): [Rgb, Rgb] => [theme[`gate-${gate}`], theme.card]],
  [`gate ${gate} / soft`, (theme: Theme): [Rgb, Rgb] => [theme[`gate-${gate}`], theme[`gate-${gate}-soft`]]],
]);

const textPairs: ContrastPair[] = [
  ["foreground / background", (theme: Theme) => [theme.foreground, theme.background]],
  ["muted foreground / background", (theme: Theme) => [theme["muted-foreground"], theme.background]],
  ["muted foreground / muted", (theme: Theme) => [theme["muted-foreground"], theme.muted]],
  ["brand text / background", (theme: Theme) => [theme["brand-text"], theme.background]],
  ["brand text / signal fill", (theme: Theme, isDark: boolean) => [isDark ? theme.brand : theme["brand-text"], mix(theme.brand, theme.background, isDark ? 0.15 : 0.1)]],
  ...gatePairs,
  ["amber banner", (_theme: Theme, isDark: boolean) => isDark ? [color("#fef3c7"), color("#451a03")] : [color("#78350f"), color("#fffbeb")]],
  ["emerald banner", (_theme: Theme, isDark: boolean) => isDark ? [color("#a7f3d0"), color("#022c22")] : [color("#065f46"), color("#ecfdf5")]],
  ["sidebar foreground / rail", (_theme, isDark) => { const rail = isDark ? darkSidebar : sidebar; return [rail.foreground, rail.background]; }],
  ["sidebar muted foreground / rail", (_theme, isDark) => { const rail = isDark ? darkSidebar : sidebar; return [rail["muted-foreground"], rail.background]; }],
];

const componentPairs: ContrastPair[] = [
  ["sidebar focus ring / rail", (_theme, isDark) => { const rail = isDark ? darkSidebar : sidebar; return [rail.ring, rail.background]; }],
  ["sidebar separator / rail", (_theme, isDark) => { const rail = isDark ? darkSidebar : sidebar; return [rail.border, rail.background]; }],
];

describe.each([["light", light, false], ["dark", dark, true]] as const)("%s theme contrast", (_name, theme, isDark) => {
  it.each(textPairs)("keeps %s at 4.5:1 or higher", (_combo, pair) => {
    const [foreground, background] = pair(theme, isDark);
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(componentPairs)("keeps %s at 3:1 or higher", (_combo, pair) => {
    const [foreground, background] = pair(theme, isDark);
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(3);
  });
});

describe("dark mode keeps the rail and the canvas apart", () => {
  it("gives the sidebar its own surface rather than the canvas value", () => {
    // Light mode separates the two by tone — dark slate rail on off-white paper.
    // Dark mode had set the rail to #1e1f1e, the dark canvas value, so the two
    // surfaces became one and only a hairline border was left doing the work.
    const darkRail = tokens("\\.dark \\.brand-sidebar");
    const darkTheme = tokens("\\.dark");

    expect(darkRail.background).toBeDefined();
    expect(darkRail.background).not.toEqual(darkTheme.background);
  });

  it("keeps sidebar text legible on the deeper rail", () => {
    const rail = { ...tokens("\\.brand-sidebar"), ...tokens("\\.dark \\.brand-sidebar") };
    expect(contrast(rail.foreground, rail.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rail["muted-foreground"], rail.background)).toBeGreaterThanOrEqual(4.5);
  });
});
