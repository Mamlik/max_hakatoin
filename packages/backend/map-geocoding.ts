import { createHash } from "node:crypto";
import type { Pool } from "pg";

export type GeocoderProvider = "nominatim" | "geoapify";
export type GeocodeResult = { latitude: number; longitude: number; address: string };

const REQUEST_LOCK_ID = 841703;
const CACHE_DAYS = 30;
const MISS_CACHE_DAYS = 1;

export function normalizeGeocodeQuery(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
}

function validResult(latitude: unknown, longitude: unknown, address: unknown): GeocodeResult | null {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { latitude: lat, longitude: lon, address: String(address ?? "").trim().slice(0, 300) };
}

export function parseGeocodePayload(provider: GeocoderProvider, payload: unknown): GeocodeResult | null {
  if (provider === "nominatim") {
    if (!Array.isArray(payload) || !payload.length) return null;
    const result = payload[0] as Record<string, unknown> | undefined;
    return result ? validResult(result.lat, result.lon, result.display_name) : null;
  }
  const results = (payload as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || !results.length) return null;
  const result = results[0] as Record<string, unknown> | undefined;
  return result ? validResult(result.lat, result.lon, result.formatted) : null;
}

function geocodeUrl(provider: GeocoderProvider, query: string, settings: {
  nominatimUrl: string;
  geoapifyApiKey: string;
}) {
  if (provider === "nominatim") {
    const url = new URL(settings.nominatimUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("accept-language", "ru");
    return url;
  }
  const url = new URL("https://api.geoapify.com/v1/geocode/search");
  url.searchParams.set("text", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("lang", "ru");
  url.searchParams.set("apiKey", settings.geoapifyApiKey);
  return url;
}

/**
 * The session advisory lock and timestamp row coordinate all API replicas, so the public
 * Nominatim service sees at most one uncached request per second for the whole application.
 */
export async function geocodeAddress(pool: Pick<Pool, "connect">, options: {
  provider: GeocoderProvider;
  query: string;
  nominatimUrl: string;
  geoapifyApiKey: string;
  userAgent: string;
  fetcher?: typeof fetch;
}): Promise<GeocodeResult | null> {
  const normalized = normalizeGeocodeQuery(options.query);
  if (!normalized) return null;
  const source = options.provider === "nominatim"
    ? new URL(options.nominatimUrl).toString()
    : "https://api.geoapify.com/v1/geocode/search";
  const queryHash = createHash("sha256")
    .update(`${options.provider}\0${source}\0${normalized}`)
    .digest("hex");
  const client = await pool.connect();
  let locked = false;
  let discardClient = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [REQUEST_LOCK_ID]);
    locked = true;
    const cached = await client.query<{ result: GeocodeResult | null }>(
      "SELECT result FROM map_geocoder_cache WHERE provider=$1 AND query_hash=$2 AND expires_at>now()",
      [options.provider, queryHash],
    );
    if (cached.rows.length) return cached.rows[0]!.result;

    const state = await client.query<{ wait_ms: number | string }>(
      `SELECT CASE
         WHEN last_request_at='-infinity'::timestamptz THEN 0
         ELSE GREATEST(0, 1000-1000*EXTRACT(EPOCH FROM (clock_timestamp()-last_request_at)))
       END AS wait_ms
       FROM map_geocoder_state WHERE provider=$1`,
      [options.provider],
    );
    if (!state.rows.length) throw new Error("Geocoder rate-limit state is missing");
    const delay = Math.max(0, Number(state.rows[0]!.wait_ms));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));

    await client.query(
      "UPDATE map_geocoder_state SET last_request_at=clock_timestamp() WHERE provider=$1",
      [options.provider],
    );
    const url = geocodeUrl(options.provider, options.query.trim(), options);
    const response = await (options.fetcher ?? fetch)(url, {
      headers: {
        Accept: "application/json",
        "Accept-Language": "ru",
        ...(options.provider === "nominatim" ? { "User-Agent": options.userAgent } : {}),
      },
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) throw new Error(`Geocoder responded with ${response.status}`);
    const result = parseGeocodePayload(options.provider, await response.json());
    const ttl = result ? CACHE_DAYS : MISS_CACHE_DAYS;
    await client.query(
      `INSERT INTO map_geocoder_cache(provider,query_hash,result,expires_at)
       VALUES($1,$2,$3::jsonb,now()+($4::text||' days')::interval)
       ON CONFLICT(provider,query_hash) DO UPDATE SET result=EXCLUDED.result,expires_at=EXCLUDED.expires_at,created_at=now()`,
      [options.provider, queryHash, JSON.stringify(result), ttl],
    );

    const cleanup = await client.query(
      `UPDATE map_geocoder_state SET cache_cleaned_at=now()
       WHERE provider=$1 AND cache_cleaned_at<now()-interval '1 day' RETURNING provider`,
      [options.provider],
    );
    if (cleanup.rowCount) await client.query("DELETE FROM map_geocoder_cache WHERE expires_at<=now()");
    return result;
  } finally {
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [REQUEST_LOCK_ID]);
      } catch {
        discardClient = true;
      }
    }
    client.release(discardClient);
  }
}
