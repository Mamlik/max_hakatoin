import { describe, expect, it } from "vitest";
import { haversineKm, parseViewport, roundDistanceKm, validateSocialLink } from "../packages/backend/discovery.js";

describe("salon discovery input validation", () => {
  it("accepts HTTPS links only on the domain assigned to the link type", () => {
    expect(validateSocialLink("vk", "https://vk.com/ryadom").ok).toBe(true);
    expect(validateSocialLink("vk", "https://notvk.com/ryadom").ok).toBe(false);
    expect(validateSocialLink("website", "https://bit.ly/ryadom").ok).toBe(false);
    expect(validateSocialLink("website", "javascript:alert(1)").ok).toBe(false);
  });

  it("keeps non-standard public links in the moderation queue", () => {
    expect(validateSocialLink("other", "https://studio.example.org/visit")).toMatchObject({
      ok: true,
      validationStatus: "pending",
    });
  });

  it("parses bounded map viewports and rejects invalid coordinates", () => {
    expect(parseViewport("37.4,55.5,37.8,55.9")).toEqual({
      west: 37.4,
      south: 55.5,
      east: 37.8,
      north: 55.9,
    });
    expect(parseViewport("181,0,182,1")).toBeNull();
    expect(parseViewport("2,4,1,5")).toBeNull();
  });

  it("calculates nearby distance in kilometres", () => {
    expect(haversineKm(55.7558, 37.6173, 55.7558, 37.6173)).toBe(0);
    expect(haversineKm(55.7558, 37.6173, 55.7558, 37.7173)).toBeGreaterThan(6);
  });

  it("rounds client distance to metres below one kilometre and tenths above it", () => {
    expect(roundDistanceKm(0.4328)).toBe(0.433);
    expect(roundDistanceKm(12.36)).toBe(12.4);
    expect(roundDistanceKm(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
