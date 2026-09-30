import { isIP } from "node:net";

export type SocialLinkKind =
  | "website"
  | "max"
  | "vk"
  | "telegram"
  | "instagram"
  | "tiktok"
  | "other";

const hostRules: Record<Exclude<SocialLinkKind, "website" | "other">, string[]> = {
  max: ["max.ru"],
  vk: ["vk.com", "vk.ru"],
  telegram: ["t.me", "telegram.me"],
  instagram: ["instagram.com"],
  tiktok: ["tiktok.com"],
};
const shorteners = new Set([
  "bit.ly", "t.co", "tinyurl.com", "clck.ru", "is.gd", "goo.su",
  "cutt.ly", "shorturl.at", "lnkd.in", "rb.gy", "rebrand.ly",
]);

export function validateSocialLink(kind: SocialLinkKind, raw: string) {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false as const, reason: "Укажите корректную ссылку" };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:")
    return { ok: false as const, reason: "Разрешены только ссылки HTTPS" };
  if (url.username || url.password)
    return { ok: false as const, reason: "Ссылки с логином и паролем запрещены" };
  if (!host || host === "localhost" || host.endsWith(".localhost") || isIP(host.replace(/^\[|\]$/g, "")))
    return { ok: false as const, reason: "Локальные адреса и IP-ссылки запрещены" };
  if (shorteners.has(host))
    return { ok: false as const, reason: "Сокращённые ссылки запрещены" };
  if (kind !== "website" && kind !== "other") {
    const allowed = hostRules[kind].some((domain) => host === domain || host.endsWith(`.${domain}`));
    if (!allowed)
      return { ok: false as const, reason: "Домен ссылки не соответствует выбранному типу" };
  }
  if (kind === "website" && !host.includes("."))
    return { ok: false as const, reason: "Укажите публичный домен сайта" };
  return {
    ok: true as const,
    url: url.toString(),
    validationStatus: kind === "other" ? "pending" as const : "approved" as const,
  };
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const radians = Math.PI / 180;
  const dLat = (lat2 - lat1) * radians;
  const dLon = (lon2 - lon1) * radians;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function roundDistanceKm(distanceKm: number) {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return null;
  return distanceKm < 1
    ? Math.round(distanceKm * 1000) / 1000
    : Math.round(distanceKm * 10) / 10;
}

export function parseViewport(raw: string) {
  const values = raw.split(",").map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return null;
  const [west, south, east, north] = values as [number, number, number, number];
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) return null;
  return { west, south, east, north };
}
