import { describe, expect, it } from "vitest";
import {
  STOREFRONT_ACCENTS,
  STOREFRONT_MODES,
  STOREFRONT_PRESETS,
  storefrontTokens,
} from "../apps/web/src/storefront-tokens.js";

const luminance = (hex: string) => {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((value) => parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
};
const contrast = (a: string, b: string) => {
  const [bright, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (bright! + 0.05) / (dark! + 0.05);
};

describe("storefront theme tokens", () => {
  it("keeps all 24 preset/mode/accent combinations within contrast guardrails", () => {
    for (const preset of STOREFRONT_PRESETS)
      for (const mode of STOREFRONT_MODES)
        for (const accent of STOREFRONT_ACCENTS) {
          const token = storefrontTokens(mode, accent);
          const label = `${preset}/${mode}/${accent}`;
          expect(contrast(token.text, token.background), label).toBeGreaterThanOrEqual(4.5);
          expect(contrast(token.muted, token.background), label).toBeGreaterThanOrEqual(4.5);
          expect(contrast(token.accentText, token.accent), label).toBeGreaterThanOrEqual(4.5);
          expect(contrast(token.border, token.surface), label).toBeGreaterThanOrEqual(3);
          expect(contrast(token.focus, token.background), label).toBeGreaterThanOrEqual(3);
        }
  });
});
