import type { CSSProperties } from "react";

const accents = {
  violet: "#6a50bc",
  rose: "#914f5d",
  teal: "#3f756d",
  amber: "#795f32",
} as const;

export const STOREFRONT_PRESETS = ["studio", "editorial", "noir"] as const;
export const STOREFRONT_MODES = ["light", "dark"] as const;
export const STOREFRONT_ACCENTS = Object.keys(accents) as Array<keyof typeof accents>;

export function storefrontTokens(
  mode: (typeof STOREFRONT_MODES)[number],
  accent: keyof typeof accents,
) {
  const dark = mode === "dark";
  return {
    background: dark ? "#17161b" : "#ffffff",
    surface: dark ? "#222027" : "#ffffff",
    text: dark ? "#f6f2f7" : "#252330",
    muted: dark ? "#bbb3c0" : "#625b69",
    border: dark ? "#8d8791" : "#77707f",
    accent: accents[accent],
    accentText: "#ffffff",
    focus: dark ? "#c4b5fd" : accents[accent],
    accentLight: dark ? "#2d2933" : "#eee9f4",
  };
}

export function storefrontTokenStyle(
  mode: (typeof STOREFRONT_MODES)[number],
  accent: keyof typeof accents,
): CSSProperties {
  const token = storefrontTokens(mode, accent);
  return {
    "--sf-bg": token.background,
    "--sf-surface": token.surface,
    "--sf-text": token.text,
    "--sf-muted": token.muted,
    "--sf-line": token.border,
    "--accent": token.accent,
    "--accent-light": token.accentLight,
    "--focus": token.focus,
  } as CSSProperties;
}
