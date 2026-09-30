import { describe, expect, it } from "vitest";
import { geocodeAddress, normalizeGeocodeQuery, parseGeocodePayload } from "../packages/backend/map-geocoding";

describe("address geocoding", () => {
  it("normalizes whitespace and Russian ё for stable request caching", () => {
    expect(normalizeGeocodeQuery("  МОСКВА   ул. Ёлочная, 3 ")).toBe("москва ул. елочная, 3");
  });

  it("reads the first valid Nominatim result and ignores invalid coordinates", () => {
    expect(parseGeocodePayload("nominatim", [{
      lat: "55.7558", lon: "37.6173", display_name: "Москва, Россия",
    }])).toEqual({ latitude: 55.7558, longitude: 37.6173, address: "Москва, Россия" });
    expect(parseGeocodePayload("nominatim", [{ lat: "91", lon: "37", display_name: "wrong" }])).toBeNull();
    expect(parseGeocodePayload("nominatim", [])).toBeNull();
  });

  it("reads Geoapify results using the same shape returned to the editor", () => {
    expect(parseGeocodePayload("geoapify", { results: [{
      lat: 55.7558, lon: 37.6173, formatted: "Москва, Россия",
    }] })).toEqual({ latitude: 55.7558, longitude: 37.6173, address: "Москва, Россия" });
    expect(parseGeocodePayload("geoapify", { results: [{ lat: "NaN", lon: 37 }] })).toBeNull();
    expect(parseGeocodePayload("geoapify", {})).toBeNull();
  });

  it("proxies manual address lookups with an app identity and reuses provider-scoped cache entries", async () => {
    const cache = new Map<string, unknown>();
    const sqlCalls: string[] = [];
    const makeClient = () => ({
      query: async (sql: string, values: unknown[] = []) => {
        sqlCalls.push(sql);
        if (sql.includes("pg_advisory_lock")) return { rows: [], rowCount: 1 };
        if (sql.includes("SELECT result FROM map_geocoder_cache")) {
          const result = cache.get(String(values[1]));
          return { rows: result === undefined ? [] : [{ result }], rowCount: result === undefined ? 0 : 1 };
        }
        if (sql.includes("SELECT CASE")) return { rows: [{ wait_ms: 0 }], rowCount: 1 };
        if (sql.includes("INSERT INTO map_geocoder_cache")) {
          cache.set(String(values[1]), JSON.parse(String(values[2])));
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    });
    const pool = { connect: async () => makeClient() } as any;
    const requests: Array<{ url: URL; userAgent?: string }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: new URL(String(input)), userAgent: new Headers(init?.headers).get("User-Agent") ?? undefined });
      return new Response(JSON.stringify([{ lat: "55.7558", lon: "37.6173", display_name: "Москва, Россия" }]), { status: 200 });
    };
    const options = {
      provider: "nominatim" as const,
      query: "Москва, ул. Ёлочная 3",
      nominatimUrl: "https://nominatim.openstreetmap.org/search",
      geoapifyApiKey: "",
      userAgent: "RyadomSalon/1.0 (https://example.test)",
      fetcher,
    };

    await expect(geocodeAddress(pool, options)).resolves.toEqual({
      latitude: 55.7558, longitude: 37.6173, address: "Москва, Россия",
    });
    await expect(geocodeAddress(pool, { ...options, query: "москва, ул. елочная 3" })).resolves.toEqual({
      latitude: 55.7558, longitude: 37.6173, address: "Москва, Россия",
    });
    await expect(geocodeAddress(pool, { ...options, nominatimUrl: "https://nominatim.example/search" })).resolves.toEqual({
      latitude: 55.7558, longitude: 37.6173, address: "Москва, Россия",
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url.searchParams.get("format")).toBe("jsonv2");
    expect(requests[0]!.url.searchParams.get("limit")).toBe("1");
    expect(requests[0]!.userAgent).toBe("RyadomSalon/1.0 (https://example.test)");
    expect(sqlCalls.filter((query) => query.includes("pg_advisory_lock"))).toHaveLength(3);
    expect(sqlCalls.filter((query) => query.includes("pg_advisory_unlock"))).toHaveLength(3);
  });
});
