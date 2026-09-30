import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DateTime, IANAZone } from "luxon";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import QRCode from "qrcode";
import { route, audit, list } from "./http.js";
import { one, pool, rows, type DB } from "../db/db.js";
import { authenticate } from "./auth.js";
import { required, fail, version } from "./errors.js";
import { config } from "./config.js";
import {
  profile,
  style,
  expected,
  command,
  empty,
  service,
  staff,
  text,
  id,
  schedule,
  interval,
  date,
  discoveryProfile,
  salonSocialLink,
} from "../contracts/schemas.js";
import type {
  Tenant,
  Style,
  Service,
  Staff,
  Booking,
  Weekday,
  Interval,
} from "./types.js";
import {
  slots,
  validateIntervals,
  snapshotDays,
  utcIntervals,
} from "./scheduling.js";
import { parseViewport, roundDistanceKm, validateSocialLink } from "./discovery.js";
import { geocodeAddress } from "./map-geocoding.js";

const manage = ["owner", "admin"] as ("owner" | "admin")[];
const defaultDiscoveryProfile = {
  shortDescription: "",
  description: "",
  showMap: false,
  showHours: true,
  showGallery: true,
  showRating: true,
  showLinks: true,
  address: "",
  city: "",
  district: "",
  metroStations: [] as string[],
  latitude: null as number | null,
  longitude: null as number | null,
};
const catalogMedia = ["owner", "admin", "master"] as (
  | "owner"
  | "admin"
  | "master"
)[];
const styleDefaults = {
  schemaVersion: 2 as const,
  themePreset: "studio" as const,
  colorMode: "light" as const,
  coverFocalPoint: { x: 50, y: 50 },
  serviceCards: { variant: "compact" as const, showDescription: true },
  staffCards: {
    variant: "compact" as const,
    showDescription: true,
    showRating: true,
  },
  sectionOrder: ["services", "staff", "gallery"] as (
    | "services"
    | "staff"
    | "gallery"
  )[],
  galleryMediaIds: [] as string[],
};
function normalizeStyle(value: Style): Style {
  return {
    ...styleDefaults,
    ...value,
    schemaVersion: 2,
    coverFocalPoint: value.coverFocalPoint ?? styleDefaults.coverFocalPoint,
    serviceCards: value.serviceCards ?? styleDefaults.serviceCards,
    staffCards: value.staffCards ?? styleDefaults.staffCards,
    sectionOrder:
      value.sectionOrder?.length === 3
        ? value.sectionOrder
        : [...styleDefaults.sectionOrder],
    galleryMediaIds: value.galleryMediaIds ?? [],
  };
}
function queryNumber(value: string | undefined, label: string, min: number, max: number) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max)
    fail(400, "INVALID_FILTER", `Проверьте фильтр «${label}»`, { field: label });
  return parsed;
}
function queryList(value: string | undefined, maxItems = 30) {
  const items = (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (items.length > maxItems) fail(400, "INVALID_FILTER", "Слишком много значений фильтра");
  return [...new Set(items)];
}
function readCursor(raw: string | undefined, sort: string): { metric: number | string | null; code: string } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (value.sort !== sort || typeof value.code !== "string" || value.code.length > 80 ||
      !(value.metric === null || typeof value.metric === "string" || (typeof value.metric === "number" && Number.isFinite(value.metric))))
      throw new Error("Invalid cursor");
    return { metric: value.metric, code: value.code };
  } catch {
    fail(400, "INVALID_CURSOR", "Параметр продолжения поиска повреждён");
  }
}
export async function tenantById(db: DB, id: string) {
  return required(
    await one<Tenant>(db, "SELECT * FROM tenants WHERE id=$1", [id]),
  );
}
export async function publishCheck(db: DB, tenant: Tenant) {
  const hasService = !!(await one(
    db,
    "SELECT 1 FROM services WHERE tenant_id=$1 AND active",
    [tenant.id],
  ));
  const hasStaff = !!(await one(
    db,
    "SELECT 1 FROM staff s JOIN staff_services ss ON ss.staff_id=s.id JOIN services v ON v.id=ss.service_id WHERE s.tenant_id=$1 AND s.active AND v.active",
    [tenant.id],
  ));
  const hasSchedule = !!(await one(
    db,
    "SELECT 1 FROM schedules sc JOIN staff s ON s.id=sc.staff_id JOIN staff_services ss ON ss.staff_id=s.id JOIN services v ON v.id=ss.service_id WHERE sc.tenant_id=$1 AND s.active AND v.active AND EXISTS (SELECT 1 FROM jsonb_array_elements(sc.weekly) d CROSS JOIN jsonb_array_elements(d->'intervals') i WHERE i->>'kind'='work')",
    [tenant.id],
  ));
  const discovery = await one<{ draft: Record<string, unknown> }>(
    db,
    "SELECT draft FROM salon_discovery_profiles WHERE tenant_id=$1",
    [tenant.id],
  );
  const location = discovery?.draft.showMap === true
    ? await one<{ draft_latitude: number | null; draft_longitude: number | null; draft_geo_status: string }>(
      db,
      "SELECT draft_latitude,draft_longitude,draft_geo_status FROM salon_locations WHERE tenant_id=$1",
      [tenant.id],
    )
    : undefined;
  return [
    {
      key: "profile",
      label: "Профиль и контакт",
      done: !!tenant.name && !!tenant.address && !!tenant.contact,
    },
    { key: "service", label: "Активная услуга", done: hasService },
    { key: "staff", label: "Мастер, оказывающий услугу", done: hasStaff },
    { key: "schedule", label: "Рабочий график", done: hasSchedule },
    ...(discovery?.draft.showMap === true
      ? [{ key: "mapLocation", label: "Точка на карте подтверждена", done: !!location && location.draft_latitude !== null && location.draft_longitude !== null && location.draft_geo_status === "verified" }]
      : []),
  ];
}
async function publishDiscovery(db: DB, tenantId: string) {
  const record = await one<{ draft: Record<string, unknown> }>(
    db,
    "SELECT draft FROM salon_discovery_profiles WHERE tenant_id=$1",
    [tenantId],
  );
  if (!record) return;
  const location = await one<{
    draft_latitude: number | null;
    draft_longitude: number | null;
    draft_geo_status: string;
  }>(db, "SELECT draft_latitude,draft_longitude,draft_geo_status FROM salon_locations WHERE tenant_id=$1", [tenantId]);
  if (record.draft.showMap === true && (!location || location.draft_latitude === null || location.draft_longitude === null || location.draft_geo_status !== "verified"))
    fail(422, "LOCATION_REVIEW_REQUIRED", "Для публикации точки на карте дождитесь проверки координат");
  await db.query(
    `UPDATE salon_discovery_profiles SET published=draft,published_version=draft_version,updated_at=now() WHERE tenant_id=$1`,
    [tenantId],
  );
  await db.query(
    `UPDATE salon_locations SET
       published_latitude=draft_latitude,published_longitude=draft_longitude,
       published_address=draft_address,published_city=draft_city,published_district=draft_district,
       published_metro_stations=draft_metro_stations,published_geo_status=draft_geo_status
     WHERE tenant_id=$1`,
    [tenantId],
  );
  await db.query(
    `UPDATE salon_social_links SET published_url=NULL,published_kind=NULL,published_label=NULL,published_sort_order=NULL
     WHERE tenant_id=$1 AND draft_url IS NULL`,
    [tenantId],
  );
  await db.query(
    `UPDATE salon_social_links SET published_kind=kind,published_url=draft_url,published_label=draft_label,
       published_sort_order=draft_sort_order
     WHERE tenant_id=$1 AND draft_url IS NOT NULL AND draft_validation_status='approved'`,
    [tenantId],
  );
}
async function publishStyle(db: DB, tenant: Tenant) {
  await publishDiscovery(db, tenant.id);
  const draftStyle = normalizeStyle(tenant.draft_style);
  for (const asset of [
    draftStyle.logoMediaId,
    draftStyle.coverMediaId,
    ...draftStyle.galleryMediaIds!,
  ].filter(Boolean)) {
    const media = required(
      await one<{ file_key: string }>(
        db,
        "SELECT file_key FROM media_assets WHERE id=$1 AND tenant_id=$2",
        [asset, tenant.id],
      ),
    );
    await mkdir(path.join(config.MEDIA_ROOT, "published"), { recursive: true });
    await copyFile(
      path.join(config.MEDIA_ROOT, "private", media.file_key),
      path.join(config.MEDIA_ROOT, "published", media.file_key),
    );
    await db.query("UPDATE media_assets SET published=true WHERE id=$1", [
      asset,
    ]);
  }
  return one<Tenant>(
    db,
    "UPDATE tenants SET draft_style=$3,published_style=$3,published_profile=$2,version=version+1 WHERE id=$1 RETURNING *",
    [
      tenant.id,
      JSON.stringify({
        name: tenant.name,
        category: tenant.category,
        address: tenant.address,
        contact: tenant.contact,
        timezone: tenant.timezone,
      }),
      JSON.stringify(draftStyle),
    ],
  );
}
async function publishCatalogMedia(
  db: DB,
  tenantId: string,
  mediaId: string | null | undefined,
  purpose: "staff" | "service" | "logo",
) {
  if (!mediaId) return;
  const media = required(
    await one<{ file_key: string }>(
      db,
      "SELECT file_key FROM media_assets WHERE id=$1 AND tenant_id=$2 AND purpose=$3",
      [mediaId, tenantId, purpose],
    ),
  );
  await mkdir(path.join(config.MEDIA_ROOT, "published"), { recursive: true });
  await copyFile(
    path.join(config.MEDIA_ROOT, "private", media.file_key),
    path.join(config.MEDIA_ROOT, "published", media.file_key),
  );
  await db.query("UPDATE media_assets SET published=true WHERE id=$1", [
    mediaId,
  ]);
}
export async function publicSalon(db: DB, tenant: Tenant) {
  const assets = await rows(
    db,
    "SELECT id,file_key FROM media_assets WHERE tenant_id=$1 AND published",
    [tenant.id],
  );
  const discovery = await one<{ published: Record<string, unknown> }>(
    db,
    "SELECT published FROM salon_discovery_profiles WHERE tenant_id=$1",
    [tenant.id],
  );
  const location = await one<{
    published_latitude: number | null;
    published_longitude: number | null;
    published_address: string;
    published_city: string;
    published_district: string;
    published_metro_stations: string[];
    published_geo_status: string;
  }>(
    db,
    "SELECT published_latitude,published_longitude,published_address,published_city,published_district,published_metro_stations,published_geo_status FROM salon_locations WHERE tenant_id=$1",
    [tenant.id],
  );
  const storedProfile = discovery?.published ?? {
    shortDescription: "",
    description: normalizeStyle(tenant.published_style).description,
    showMap: false,
    showHours: true,
    showGallery: true,
    showRating: true,
    showLinks: false,
  };
  // Location editing fields live in this JSON for one atomic draft payload. Never expose
  // them from the profile object; public coordinates are returned only through mapVisible.
  const profile = {
    shortDescription: storedProfile.shortDescription ?? "",
    description: storedProfile.description ?? "",
    showMap: storedProfile.showMap === true,
    showHours: storedProfile.showHours !== false,
    showGallery: storedProfile.showGallery !== false,
    showRating: storedProfile.showRating !== false,
    showLinks: storedProfile.showLinks === true,
  };
  const mapVisible = profile.showMap === true && location?.published_geo_status === "verified" &&
    location.published_latitude !== null && location.published_longitude !== null;
  const socialLinks = profile.showLinks
    ? await rows(db,
      "SELECT id,published_kind kind,published_url url,published_label label,published_sort_order sort_order FROM salon_social_links WHERE tenant_id=$1 AND published_url IS NOT NULL ORDER BY published_sort_order,created_at",
      [tenant.id],
    )
    : [];
  const rating = profile.showRating
    ? await one<{ average: number | null; count: number }>(
      db,
      `SELECT CASE WHEN count(*)>=3 THEN round(avg(rating)::numeric,1)::float8 ELSE NULL END average,
              CASE WHEN count(*)>=3 THEN count(*)::int ELSE 0 END count
       FROM visit_reviews WHERE tenant_id=$1 AND status='active'`,
      [tenant.id],
    )
    : undefined;
  const hours: { weekday: number; intervals: { start: string; end: string }[] }[] = [];
  if (profile.showHours) {
    const schedules = await rows<{ weekly: Weekday[] }>(
      db,
      `SELECT sc.weekly FROM schedules sc JOIN staff s ON s.id=sc.staff_id AND s.tenant_id=sc.tenant_id
       WHERE sc.tenant_id=$1 AND s.active AND sc.effective_from<=(now() AT TIME ZONE $2)::date
         AND sc.version=(SELECT max(s2.version) FROM schedules s2 WHERE s2.staff_id=s.id AND s2.effective_from<=(now() AT TIME ZONE $2)::date)`,
      [tenant.id, tenant.timezone],
    );
    const byDay = new Map<number, Array<[number, number]>>();
    const toMinute = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
    for (const { weekly } of schedules) for (const day of weekly ?? []) {
      const work = day.intervals.filter((item) => item.kind === "work").map((item) => [toMinute(item.start), toMinute(item.end)] as [number, number]);
      const breaks = day.intervals.filter((item) => item.kind === "break").map((item) => [toMinute(item.start), toMinute(item.end)] as [number, number]);
      const remaining: Array<[number, number]> = [];
      for (const [start, end] of work) {
        let segments: Array<[number, number]> = [[start, end]];
        for (const [breakStart, breakEnd] of breaks) {
          const next: Array<[number, number]> = [];
          for (const [left, right] of segments) {
            if (breakEnd <= left || breakStart >= right) next.push([left, right]);
            else {
              if (breakStart > left) next.push([left, breakStart]);
              if (breakEnd < right) next.push([breakEnd, right]);
            }
          }
          segments = next;
        }
        remaining.push(...segments);
      }
      byDay.set(day.weekday, [...(byDay.get(day.weekday) ?? []), ...remaining]);
    }
    for (let weekday = 1; weekday <= 7; weekday++) {
      const sorted = (byDay.get(weekday) ?? []).sort((a, b) => a[0] - b[0]);
      const merged = sorted.reduce<Array<[number, number]>>((result, interval) => {
        const last = result.at(-1);
        if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
        else result.push([...interval]);
        return result;
      }, []);
      hours.push({ weekday, intervals: merged.map(([start, end]) => ({
        start: `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`,
        end: `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`,
      })) });
    }
  }
  return {
    id: tenant.id,
    publicCode: tenant.public_code,
    ...tenant.published_profile,
    address: mapVisible
      ? location!.published_address
      : [location?.published_city, location?.published_district].filter(Boolean).join(", ") || "Адрес уточняется",
    style: normalizeStyle(tenant.published_style),
    media: assets,
    partnerEnabled: tenant.partner_enabled,
    discoveryProfile: profile,
    location: mapVisible ? {
      latitude: Number(location!.published_latitude),
      longitude: Number(location!.published_longitude),
      address: location!.published_address,
      city: location!.published_city,
      district: location!.published_district,
      metroStations: location!.published_metro_stations,
      geoStatus: "verified",
    } : null,
    socialLinks,
    hours,
    rating: rating?.average === null || rating?.average === undefined
      ? null
      : { average: rating.average, count: rating.count },
  };
}
export function salonRoutes(app: FastifyInstance) {
  route(
    app,
    "POST",
    "/api/v1/tenants/:t/discovery/geocode",
    {
      roles: manage,
      schema: z.object({ address: z.string().trim().min(3).max(300) }).strict(),
      noIdempotency: true,
      // The geocoder holds its own session advisory lock while waiting for provider quota.
      noTransaction: true,
      description: "Ручной поиск координат адреса салона",
    },
    async ({ b }) => {
      if (!config.SALON_DISCOVERY_GEOCODER_ENABLED)
        fail(503, "GEOCODER_DISABLED", "Поиск адресов временно отключён");
      const provider = config.SALON_DISCOVERY_GEOCODER_PROVIDER;
      if (provider === "geoapify" && !config.SALON_DISCOVERY_GEOAPIFY_API_KEY)
        fail(503, "GEOCODER_NOT_CONFIGURED", "Провайдер поиска адреса не настроен");
      try {
        return await geocodeAddress(pool, {
          provider,
          query: b.address,
          nominatimUrl: config.SALON_DISCOVERY_NOMINATIM_URL,
          geoapifyApiKey: config.SALON_DISCOVERY_GEOAPIFY_API_KEY,
          userAgent: `RyadomSalon/1.0 (${config.PUBLIC_APP_URL})`,
        });
      } catch {
        fail(503, "GEOCODER_UNAVAILABLE", "Поиск адреса временно недоступен. Можно поставить точку на карте вручную.");
      }
    },
  );
  route(
    app,
    "GET",
    "/api/v1/public/salons",
    {
      public: true,
      description: "Поиск опубликованных салонов по названию, коду, категории и активным услугам",
    },
    async ({ db, q }) => {
      const requestedLimit = Number(q.limit);
      const requestedOffset = Number(q.cursor);
      const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(100, requestedLimit) : 100;
      const offset = Number.isSafeInteger(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;
      const result = await rows<Tenant>(
        db,
        `SELECT t.* FROM tenants t WHERE t.status='published' AND
          ($1='' OR lower(t.published_profile->>'name') LIKE '%'||lower($1)||'%'
           OR lower(t.published_profile->>'category') LIKE '%'||lower($1)||'%'
           OR lower(t.published_profile->>'address') LIKE '%'||lower($1)||'%'
           OR lower(t.public_code)=lower($1)
           OR EXISTS (SELECT 1 FROM services s WHERE s.tenant_id=t.id AND s.active=true
             AND (lower(s.name) LIKE '%'||lower($1)||'%' OR lower(s.description) LIKE '%'||lower($1)||'%')))
         ORDER BY t.name, t.id LIMIT $2 OFFSET $3`,
        [(q.query ?? "").slice(0, 120), limit + 1, offset],
      );
      return {
        items: await Promise.all(result.slice(0, limit).map((t) => publicSalon(db, t))),
        nextCursor: result.length > limit ? String(offset + limit) : null,
      };
    },
  );
  route(
    app,
    "GET",
    "/api/v1/public/salons/discover",
    { public: true, description: "Единый поиск опубликованных салонов для списка и карты" },
    async ({ db, q, request }) => {
      if (!config.SALON_DISCOVERY_SEARCH_ENABLED)
        fail(404, "FEATURE_DISABLED", "Расширенный поиск временно недоступен");
      const mode = q.mode ?? "list";
      if (mode !== "map" && mode !== "list")
        fail(400, "INVALID_FILTER", "Неизвестный режим поиска", { field: "mode" });
      const sort = q.sort ?? "recommended";
      if (!["recommended", "nearby", "cheaper", "expensive", "name"].includes(sort))
        fail(400, "INVALID_FILTER", "Неизвестная сортировка", { field: "sort" });
      const favoritesOnly = q.favoritesOnly === "true";
      const user = favoritesOnly && request.headers.authorization
        ? await authenticate(db, request.headers.authorization)
        : undefined;
      if (favoritesOnly && !user)
        fail(401, "AUTH_REQUIRED", "Войдите, чтобы увидеть избранные салоны");

      const qText = (q.q ?? "").trim().slice(0, 120);
      for (const field of ["openNow", "onlineBooking", "favoritesOnly"] as const)
        if (q[field] !== undefined && q[field] !== "true" && q[field] !== "false")
          fail(400, "INVALID_FILTER", `Некорректное значение фильтра «${field}»`, { field });
      const categories = queryList(q.categories, 20).map((value) => value.slice(0, 120));
      const services = queryList(q.serviceIds, 30);
      if (services.some((value) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)))
        fail(400, "INVALID_FILTER", "Некорректный фильтр услуг", { field: "serviceIds" });
      const lat = queryNumber(q.lat, "lat", -90, 90);
      const lng = queryNumber(q.lng, "lng", -180, 180);
      if ((lat === undefined) !== (lng === undefined))
        fail(400, "INVALID_FILTER", "Для поиска рядом нужны широта и долгота");
      const radius = queryNumber(q.radiusKm, "radiusKm", 1, 25);
      if (radius !== undefined && lat === undefined)
        fail(400, "INVALID_FILTER", "Сначала укажите точку для поиска рядом");
      if (sort === "nearby" && lat === undefined)
        fail(400, "INVALID_FILTER", "Сортировка по расстоянию доступна после выбора точки");
      const viewport = q.viewport ? parseViewport(q.viewport) : null;
      if (q.viewport && !viewport)
        fail(400, "INVALID_FILTER", "Некорректная область карты", { field: "viewport" });
      const zoom = queryNumber(q.zoom, "zoom", 1, 20);
      const minPrice = queryNumber(q.minPriceMinor, "minPriceMinor", 0, 100000000);
      const maxPrice = queryNumber(q.maxPriceMinor, "maxPriceMinor", 0, 100000000);
      if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice)
        fail(400, "INVALID_FILTER", "Минимальная цена больше максимальной");
      const city = (q.city ?? "").trim().slice(0, 120);
      const district = (q.district ?? "").trim().slice(0, 120);
      const metro = queryList(q.metroIds, 3).map((value) => value.slice(0, 80));

      const args: unknown[] = [];
      const bind = (value: unknown) => { args.push(value); return `$${args.length}`; };
      const where = ["t.status='published'"];
      const normalizedQuery = qText.replace(/ё/gi, "е").toLowerCase();
      const visibleMapExpr = `(coalesce((dp.published->>'showMap')::boolean,false) AND loc.published_geo_status='verified' AND loc.published_point IS NOT NULL)`;
      const searchTextArg = bind(normalizedQuery);
      const searchArg = bind(qText ? `%${normalizedQuery.replace(/[\\%_]/g, "\\$&")}%` : "");
      const searchTextExpr = (expr: string) => `replace(lower(coalesce(${expr},'')),'ё','е')`;
      if (qText) {
        const fields = [
          "t.published_profile->>'name'", "t.category",
          "dp.published->>'shortDescription'", "dp.published->>'description'",
          "loc.published_city", "loc.published_district",
        ];
        const textual = fields.map((field) => `${searchTextExpr(field)} LIKE ${searchArg} ESCAPE '\\'`);
        textual.push(`(${visibleMapExpr} AND ${searchTextExpr("loc.published_address")} LIKE ${searchArg} ESCAPE '\\')`);
        textual.push(`EXISTS(SELECT 1 FROM services sx WHERE sx.tenant_id=t.id AND sx.active AND ${searchTextExpr("sx.name")} LIKE ${searchArg} ESCAPE '\\')`);
        textual.push(`EXISTS(SELECT 1 FROM unnest(loc.published_metro_stations) m WHERE ${searchTextExpr("m")} LIKE ${searchArg} ESCAPE '\\')`);
        where.push(`(${textual.join(" OR ")})`);
      }
      if (categories.length) where.push(`t.category=ANY(${bind(categories)}::text[])`);
      if (services.length) where.push(`EXISTS(SELECT 1 FROM services sf WHERE sf.tenant_id=t.id AND sf.active AND sf.id=ANY(${bind(services)}::uuid[]))`);
      if (city) where.push(`lower(coalesce(loc.published_city,''))=lower(${bind(city)})`);
      if (district) where.push(`lower(coalesce(loc.published_district,''))=lower(${bind(district)})`);
      if (metro.length) where.push(`loc.published_metro_stations && ${bind(metro)}::text[]`);

      const selectedServices = bind(services);
      const priceExpr = `(CASE WHEN cardinality(${selectedServices}::uuid[])>0 THEN
        (SELECT min(sv.price_minor) FROM services sv WHERE sv.tenant_id=t.id AND sv.active AND sv.id=ANY(${selectedServices}::uuid[]))
        ELSE (SELECT min(sv.price_minor) FROM services sv WHERE sv.tenant_id=t.id AND sv.active) END)`;
      if (sort === "cheaper" || sort === "expensive") where.push(`${priceExpr} IS NOT NULL`);
      if (minPrice !== undefined) where.push(`${priceExpr}>=${bind(minPrice)}`);
      if (maxPrice !== undefined) where.push(`${priceExpr}<=${bind(maxPrice)}`);

      const latArg = lat === undefined ? null : bind(lat);
      const lngArg = lng === undefined ? null : bind(lng);
      const distanceExpr = latArg && lngArg
        ? `CASE WHEN ${visibleMapExpr} THEN ST_Distance(loc.published_point,ST_SetSRID(ST_MakePoint(${lngArg},${latArg}),4326)::geography)/1000.0 ELSE NULL::float8 END`
        : "NULL::float8";
      if (mode === "map") where.push(visibleMapExpr);
      if (radius !== undefined) where.push(`${visibleMapExpr} AND ST_DWithin(loc.published_point,ST_SetSRID(ST_MakePoint(${lngArg},${latArg}),4326)::geography,${bind(radius * 1000)})`);
      else if (sort === "nearby") where.push(visibleMapExpr);
      if (viewport) {
        const west = bind(viewport.west), south = bind(viewport.south), east = bind(viewport.east), north = bind(viewport.north);
        where.push(`${visibleMapExpr} AND loc.published_point && ST_MakeEnvelope(${west},${south},${east},${north},4326)::geography`);
      }
      const localDate = `(now() AT TIME ZONE t.timezone)::date`;
      const localTime = `(now() AT TIME ZONE t.timezone)::time`;
      const openNowExpr = `EXISTS(
          SELECT 1 FROM staff os JOIN staff_services oss ON oss.staff_id=os.id
          JOIN services ovs ON ovs.id=oss.service_id AND ovs.tenant_id=os.tenant_id AND ovs.active
          WHERE os.tenant_id=t.id AND os.active AND EXISTS(
            SELECT 1 FROM schedules sc WHERE sc.tenant_id=t.id AND sc.staff_id=os.id AND sc.effective_from<=${localDate}
              AND sc.version=(SELECT max(s2.version) FROM schedules s2 WHERE s2.staff_id=os.id AND s2.effective_from<=${localDate})
              AND (
                EXISTS(SELECT 1 FROM schedule_exceptions ex WHERE ex.staff_id=os.id AND ex.local_date=${localDate} AND ex.mode='replace'
                  AND EXISTS(SELECT 1 FROM jsonb_array_elements(ex.intervals) i WHERE i->>'kind'='work' AND ${localTime}>=((i->>'start')::time) AND ${localTime}<((i->>'end')::time))
                  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ex.intervals) i WHERE i->>'kind'='break' AND ${localTime}>=((i->>'start')::time) AND ${localTime}<((i->>'end')::time)))
                OR (NOT EXISTS(SELECT 1 FROM schedule_exceptions ex WHERE ex.staff_id=os.id AND ex.local_date=${localDate})
                  AND EXISTS(SELECT 1 FROM jsonb_array_elements(sc.weekly) d CROSS JOIN LATERAL jsonb_array_elements(d->'intervals') i
                    WHERE (d->>'weekday')::int=extract(isodow from ${localDate})::int AND i->>'kind'='work'
                      AND ${localTime}>=((i->>'start')::time) AND ${localTime}<((i->>'end')::time))
                  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sc.weekly) d CROSS JOIN LATERAL jsonb_array_elements(d->'intervals') i
                    WHERE (d->>'weekday')::int=extract(isodow from ${localDate})::int AND i->>'kind'='break'
                      AND ${localTime}>=((i->>'start')::time) AND ${localTime}<((i->>'end')::time)))
              )
          )
        )`;
      if (q.openNow === "true") where.push(openNowExpr);
      const onlineExpr = `EXISTS(SELECT 1 FROM services osx JOIN staff_services ssx ON ssx.service_id=osx.id
        JOIN staff stx ON stx.id=ssx.staff_id JOIN schedules scx ON scx.staff_id=stx.id AND scx.tenant_id=t.id
          AND scx.effective_from<=${localDate} AND scx.version=(SELECT max(s2.version) FROM schedules s2 WHERE s2.staff_id=stx.id AND s2.effective_from<=${localDate})
        WHERE osx.tenant_id=t.id AND osx.active AND stx.active
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(scx.weekly) d CROSS JOIN LATERAL jsonb_array_elements(d->'intervals') i WHERE i->>'kind'='work'))`;
      if (q.onlineBooking === "true") where.push(onlineExpr);
      if (q.favoritesOnly === "true") where.push(`EXISTS(SELECT 1 FROM favorites f WHERE f.user_id=${bind(user!.id)} AND f.tenant_id=t.id)`);
      if (mode === "map" && !config.SALON_DISCOVERY_MAP_ENABLED)
        fail(404, "FEATURE_DISABLED", "Режим карты временно недоступен");

      const scoreExpr = `(
        CASE WHEN ${searchTextArg}='' THEN 0
          WHEN replace(lower(t.published_profile->>'name'),'ё','е')=${searchTextArg} THEN 500
          WHEN replace(lower(t.published_profile->>'name'),'ё','е') LIKE ${searchArg} ESCAPE '\\' THEN 350
          WHEN replace(lower(t.category),'ё','е') LIKE ${searchArg} ESCAPE '\\' THEN 220 ELSE 100 END
        + CASE WHEN dp.published->>'shortDescription'<>'' THEN 10 ELSE 0 END
        + CASE WHEN ${onlineExpr} THEN 20 ELSE 0 END
      )::float8`;
      const metricExpr = sort === "nearby" ? distanceExpr
        : sort === "cheaper" || sort === "expensive" ? priceExpr
          : sort === "name" ? "lower(t.published_profile->>'name')"
            : scoreExpr;
      const metricType = sort === "name" ? "text" : "float8";
      const direction = sort === "recommended" || sort === "expensive" ? "DESC" : "ASC";
      const cursor = mode === "list" ? readCursor(q.cursor, sort) : null;
      let cursorCondition = "";
      if (cursor) {
        const metricArg = cursor.metric === null ? null : bind(cursor.metric);
        const codeArg = bind(cursor.code);
        const comparison = direction === "ASC" ? ">" : "<";
        cursorCondition = cursor.metric === null
          ? `WHERE metric IS NULL AND public_code>${codeArg}`
          : `WHERE (metric ${comparison} ${metricArg}::${metricType} OR (metric=${metricArg}::${metricType} AND public_code>${codeArg}) OR metric IS NULL)`;
      }
      const listLimit = queryNumber(q.limit, "limit", 1, 20) ?? 20;
      const limit = mode === "map" ? 501 : listLimit + 1;
      const limitParameterIndex = args.length + 1;
      const limitArg = bind(limit);
      const offsetWhere = where.join(" AND ");
      const filteredQuery = `SELECT t.id,t.public_code,t.category,t.published_profile,t.published_style,
          dp.published discovery,loc.published_latitude latitude,loc.published_longitude longitude,
          loc.published_point geo_point,loc.published_address,loc.published_city,loc.published_district,loc.published_geo_status,
          ${priceExpr} min_price_minor,${distanceExpr} distance_km,(${onlineExpr}) online_booking,
          (${scoreExpr}) relevance,${metricExpr} metric,
          CASE WHEN coalesce((dp.published->>'showMap')::boolean,false) AND loc.published_geo_status='verified' THEN loc.published_latitude ELSE NULL END map_latitude,
          CASE WHEN coalesce((dp.published->>'showMap')::boolean,false) AND loc.published_geo_status='verified' THEN loc.published_longitude ELSE NULL END map_longitude,
          CASE WHEN coalesce((dp.published->>'showMap')::boolean,false) AND loc.published_geo_status='verified' THEN loc.published_address
            ELSE nullif(concat_ws(', ',nullif(loc.published_city,''),nullif(loc.published_district,'')),'') END public_address,
          (SELECT jsonb_build_object('id',m.id,'fileKey',m.file_key,'purpose',m.purpose)
             FROM media_assets m WHERE m.tenant_id=t.id AND m.published AND m.id=(t.published_style->>'coverMediaId')::uuid LIMIT 1) cover,
          (SELECT jsonb_build_object('id',m.id,'fileKey',m.file_key,'purpose',m.purpose)
             FROM media_assets m WHERE m.tenant_id=t.id AND m.published AND m.id=(t.published_style->>'logoMediaId')::uuid LIMIT 1) logo,
          (SELECT coalesce(jsonb_agg(sv.name ORDER BY sv.name),'[]'::jsonb) FROM (
             SELECT s.name FROM services s WHERE s.tenant_id=t.id AND s.active
               AND (cardinality(${selectedServices}::uuid[])=0 OR s.id=ANY(${selectedServices}::uuid[]))
             ORDER BY s.name LIMIT 3) sv) matched_services,
          EXISTS(SELECT 1 FROM staff os JOIN staff_services ss ON ss.staff_id=os.id JOIN services s ON s.id=ss.service_id AND s.active
            JOIN schedules sc ON sc.staff_id=os.id AND sc.tenant_id=t.id WHERE os.tenant_id=t.id AND os.active) online_candidate,
          (${openNowExpr})::boolean open_now,
          ${user ? `EXISTS(SELECT 1 FROM favorites f WHERE f.user_id=${bind(user.id)} AND f.tenant_id=t.id)` : "false"} favorite,
          CASE WHEN coalesce((dp.published->>'showRating')::boolean,true) THEN
            (SELECT CASE WHEN count(*)>=3 THEN round(avg(vr.rating)::numeric,1)::float8 ELSE NULL END
             FROM visit_reviews vr WHERE vr.tenant_id=t.id AND vr.status='active') ELSE NULL END rating
        FROM tenants t
        LEFT JOIN salon_discovery_profiles dp ON dp.tenant_id=t.id
        LEFT JOIN salon_locations loc ON loc.tenant_id=t.id
        WHERE ${offsetWhere}`;
      const query = `WITH filtered AS (${filteredQuery}), page AS (
        SELECT * FROM filtered ${cursorCondition}
        ORDER BY metric ${direction} NULLS LAST, public_code ASC LIMIT ${limitArg}
      )
      SELECT page.*,counts.total_approx FROM (SELECT count(*)::int total_approx FROM filtered) counts LEFT JOIN page ON true`;
      const result = await rows<Record<string, any>>(db, query, args);
      const total = result[0]?.total_approx ?? 0;
      const pageRows = result.filter((item) => item.id !== null);
      if (mode === "map" && total > 500) {
        const clusterArgs = [...args, Math.max(0.001, 28 / 2 ** (zoom ?? 10))];
        const gridArg = `$${clusterArgs.length}`;
        const clusters = await rows(db, `WITH filtered AS (${filteredQuery})
          SELECT
            avg(ST_X(geo_point::geometry)) longitude,
            avg(ST_Y(geo_point::geometry)) latitude,
            count(*)::int count,
            min(ST_X(geo_point::geometry)) west,max(ST_X(geo_point::geometry)) east,
            min(ST_Y(geo_point::geometry)) south,max(ST_Y(geo_point::geometry)) north
          FROM filtered WHERE map_latitude IS NOT NULL AND geo_point IS NOT NULL
            AND $${limitParameterIndex}::int > 0
          GROUP BY floor(ST_X(geo_point::geometry)/${gridArg})::int,floor(ST_Y(geo_point::geometry)/${gridArg})::int`, clusterArgs);
        return { items: [], clusters, nextCursor: null, totalApprox: total, appliedFilters: { q: qText, categories, serviceIds: services, city, district, metroIds: metro, sort, mode } };
      }
      const hasNext = mode === "list" && pageRows.length > listLimit;
      const pageItems = pageRows.slice(0, mode === "map" ? 500 : listLimit);
      const items = pageItems.map((item) => ({
        id: item.id,
        publicCode: item.public_code,
        name: item.published_profile?.name,
        category: item.category,
        address: item.public_address || "Адрес уточняется",
        shortDescription: item.discovery?.shortDescription || "",
        cover: item.cover,
        logo: item.logo ?? item.cover,
        minPriceMinor: item.min_price_minor === null ? null : Number(item.min_price_minor),
        matchedServices: item.matched_services ?? [],
        onlineBooking: item.online_booking,
        openNow: item.open_now,
        distanceKm: item.distance_km === null ? null : roundDistanceKm(Number(item.distance_km)),
        favorite: item.favorite,
        rating: item.rating === null ? null : Number(item.rating),
        location: mode === "map" && item.map_latitude !== null ? { latitude: Number(item.map_latitude), longitude: Number(item.map_longitude) } : null,
      }));
      const last = pageItems.at(-1);
      const nextCursor = hasNext && last
        ? Buffer.from(JSON.stringify({ sort, metric: last.metric ?? null, code: last.public_code })).toString("base64url")
        : null;
      return {
        items,
        clusters: [],
        nextCursor,
        totalApprox: total,
        appliedFilters: { q: qText, categories, serviceIds: services, city, district, metroIds: metro, minPriceMinor: minPrice, maxPriceMinor: maxPrice, openNow: q.openNow === "true", onlineBooking: q.onlineBooking === "true", favoritesOnly, lat: lat ?? null, lng: lng ?? null, radiusKm: radius ?? null, viewport: viewport ?? null, sort, mode },
      };
    },
  );
  route(
    app,
    "GET",
    "/api/v1/public/salons/discover/facets",
    { public: true, description: "Фасеты опубликованного каталога" },
    async ({ db }) => {
      if (!config.SALON_DISCOVERY_SEARCH_ENABLED)
        fail(404, "FEATURE_DISABLED", "Расширенный поиск временно недоступен");
      const categories = await rows(db, "SELECT category name,count(*)::int count FROM tenants WHERE status='published' GROUP BY category ORDER BY category");
      const cities = await rows(db, "SELECT published_city name,count(*)::int count FROM salon_locations l JOIN tenants t ON t.id=l.tenant_id WHERE t.status='published' AND l.published_city<>'' GROUP BY published_city ORDER BY published_city");
      const districts = await rows(db, "SELECT published_district name,count(*)::int count FROM salon_locations l JOIN tenants t ON t.id=l.tenant_id WHERE t.status='published' AND l.published_district<>'' GROUP BY published_district ORDER BY published_district");
      const metros = await rows(db, "SELECT m name,count(DISTINCT t.id)::int count FROM salon_locations l JOIN tenants t ON t.id=l.tenant_id CROSS JOIN LATERAL unnest(l.published_metro_stations) m WHERE t.status='published' GROUP BY m ORDER BY m");
      const services = await rows(db, "SELECT id,name,count(DISTINCT tenant_id)::int salon_count FROM services WHERE active GROUP BY id,name ORDER BY name LIMIT 300");
      return { categories, cities, districts, metroStations: metros, services };
    },
  );
  route(
    app,
    "GET",
    "/api/v1/public/salons/:code",
    { public: true, description: "Опубликованная витрина" },
    async ({ db, p }) =>
      publicSalon(
        db,
        required(
          await one<Tenant>(
            db,
            "SELECT * FROM tenants WHERE public_code=$1 AND status='published'",
            [p.code],
          ),
        ),
      ),
  );
  route(
    app,
    "GET",
    "/api/v1/public/salons/:code/catalog",
    { public: true, description: "Активные услуги и мастера" },
    async ({ db, p }) => {
      const t = required(
        await one<Tenant>(
          db,
          "SELECT * FROM tenants WHERE public_code=$1 AND status='published'",
          [p.code],
        ),
      );
      return {
        categories: await rows(
          db,
          "SELECT id,name,sort_order FROM categories WHERE tenant_id=$1 AND NOT archived ORDER BY sort_order,name",
          [t.id],
        ),
        services: await rows(
          db,
          "SELECT id,category_id,name,description,duration_min,price_minor,cover_media_id,version FROM services WHERE tenant_id=$1 AND active ORDER BY name",
          [t.id],
        ),
        staff: await rows(
          db,
          `SELECT s.id,s.name,s.description,s.photo_media_id,
                  COALESCE(array_agg(ss.service_id) FILTER(WHERE ss.service_id IS NOT NULL),'{}') service_ids,
                  CASE WHEN rr.rating_count>=3 THEN rr.rating_average ELSE NULL END rating_average,
                  CASE WHEN rr.rating_count>=3 THEN rr.rating_count ELSE NULL END rating_count
           FROM staff s
           LEFT JOIN staff_services ss ON ss.staff_id=s.id
           LEFT JOIN LATERAL (
             SELECT round(avg(vr.rating)::numeric,1)::float8 rating_average,count(*)::int rating_count
             FROM visit_reviews vr
             WHERE vr.tenant_id=s.tenant_id AND vr.staff_id=s.id AND vr.status='active'
           ) rr ON true
           WHERE s.tenant_id=$1 AND s.active
           GROUP BY s.id,rr.rating_average,rr.rating_count ORDER BY s.name`,
          [t.id],
        ),
      };
    },
  );
  route(
    app,
    "GET",
    "/api/v1/public/salons/:code/slots",
    { public: true, description: "Свободные интервалы без удержания" },
    async ({ db, p, q }) => {
      const t = required(
        await one<Tenant>(
          db,
          "SELECT * FROM tenants WHERE public_code=$1 AND status='published'",
          [p.code],
        ),
      );
      const serviceId = id.parse(q.serviceId);
      if (q.staffId) id.parse(q.staffId);
      const from = date.parse(q.from),
        to = date.parse(q.to ?? q.from);
      return list(await slots(db, t, serviceId, from, to, q.staffId), 1500);
    },
  );
  route(
    app,
    "POST",
    "/api/v1/tenants",
    {
      schema: profile,
      description: "Создание нового салона и назначение владельца",
    },
    async ({ db, actor, b }) => {
      if (!IANAZone.isValidZone(b.timezone))
        fail(422, "VALIDATION_ERROR", "Неизвестный часовой пояс IANA");
      const t = (await one<Tenant>(
        db,
        "INSERT INTO tenants(public_code,name,category,address,timezone,contact,operational_recipient_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [
          randomBytes(6).toString("hex"),
          b.name,
          b.category,
          b.address,
          b.timezone,
          b.contact,
          actor.id,
        ],
      ))!;
      await db.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",
        [t.id, actor.id],
      );
      await audit(db, t.id, actor.id, "tenant.created", t.id);
      return t;
    },
  );
  route(
    app,
    "GET",
    "/api/v1/work/:t/profile",
    { roles: ["owner"], description: "Черновой профиль салона" },
    async ({ db, p }) => tenantById(db, p.t!),
  );
  route(
    app,
    "GET",
    "/api/v1/work/:t/onboarding",
    { roles: ["owner"], description: "Чек-лист публикации" },
    async ({ db, p }) => ({
      items: await publishCheck(db, await tenantById(db, p.t!)),
    }),
  );
  route(
    app,
    "PATCH",
    "/api/v1/work/:t/profile",
    {
      roles: ["owner"],
      schema: profile
        .extend({ expectedVersion: z.number().int().positive() })
        .strict(),
      description: "Сохранение профиля",
    },
    async ({ db, actor, p, b }) => {
      const t = await tenantById(db, p.t!);
      version(t, b.expectedVersion);
      if (!IANAZone.isValidZone(b.timezone))
        fail(422, "VALIDATION_ERROR", "Неизвестный часовой пояс");
      if (
        t.timezone !== b.timezone &&
        (await one(db, "SELECT 1 FROM bookings WHERE tenant_id=$1 LIMIT 1", [
          t.id,
        ]))
      )
        fail(
          409,
          "INVALID_STATE_TRANSITION",
          "Часовой пояс салона с историей визитов изменить нельзя",
        );
      await audit(db, t.id, actor.id, "tenant.profile", t.id);
      return one(
        db,
        "UPDATE tenants SET name=$2,category=$3,address=$4,timezone=$5,contact=$6,version=version+1 WHERE id=$1 RETURNING *",
        [t.id, b.name, b.category, b.address, b.timezone, b.contact],
      );
    },
  );
  for (const endpoint of ["draft", "preview"])
    route(
      app,
      "GET",
      `/api/v1/work/:t/storefront/${endpoint}`,
      { roles: manage, description: "Черновик и предпросмотр оформления" },
      async ({ db, p }) => {
        const t = await tenantById(db, p.t!);
        const discovery = await one<{ draft: Record<string, unknown> }>(db,
          "SELECT draft FROM salon_discovery_profiles WHERE tenant_id=$1", [t.id]);
        const location = await one<Record<string, unknown>>(db,
          `SELECT draft_latitude latitude,draft_longitude longitude,draft_address address,draft_city city,
             draft_district district,draft_metro_stations metro_stations,draft_geo_status geo_status
           FROM salon_locations WHERE tenant_id=$1`, [t.id]);
        return {
          ...t,
          draftStyle: normalizeStyle(t.draft_style),
          publishedStyle: normalizeStyle(t.published_style),
          style: normalizeStyle(t.draft_style),
          media: await rows(
            db,
            "SELECT id,file_key,purpose FROM media_assets WHERE tenant_id=$1",
            [p.t],
          ),
          discoveryDraft: { ...defaultDiscoveryProfile, ...(discovery?.draft ?? {}),
            latitude: location?.latitude === null || location?.latitude === undefined ? null : Number(location.latitude),
            longitude: location?.longitude === null || location?.longitude === undefined ? null : Number(location.longitude),
            address: location?.address ?? "", city: location?.city ?? "", district: location?.district ?? "",
            metroStations: location?.metro_stations ?? [], geoStatus: location?.geo_status ?? "draft" },
          socialLinks: await rows(db,
            `SELECT id,kind,draft_url url,draft_label label,draft_sort_order sort_order,draft_validation_status validation_status
             FROM salon_social_links WHERE tenant_id=$1 AND draft_url IS NOT NULL ORDER BY draft_sort_order,created_at`, [t.id]),
        };
      },
    );
  route(
    app,
    "PUT",
    "/api/v1/work/:t/storefront/draft",
    {
      roles: manage,
      schema: expected.extend({ style, discovery: discoveryProfile.optional(), socialLinks: z.array(salonSocialLink).max(7).optional() }).strict(),
      description: "Сохранение черновика оформления",
    },
    async ({ db, actor, p, b }) => {
      const t = await tenantById(db, p.t!);
      version(t, b.expectedVersion);
      for (const [asset, purpose] of [
        [b.style.logoMediaId, "logo"],
        [b.style.coverMediaId, "cover"],
      ])
        if (asset)
          required(
            await one(
              db,
              "SELECT id FROM media_assets WHERE id=$1 AND tenant_id=$2 AND purpose=$3",
              [asset, t.id, purpose],
            ),
          );
      for (const categoryId of b.style.categoryOrder)
        required(
          await one(
            db,
            "SELECT id FROM categories WHERE id=$1 AND tenant_id=$2",
            [categoryId, t.id],
          ),
        );
      for (const asset of b.style.galleryMediaIds)
        required(
          await one(
            db,
            "SELECT id FROM media_assets WHERE id=$1 AND tenant_id=$2 AND purpose='gallery'",
            [asset, t.id],
          ),
        );
      if (b.discovery) {
        if (!config.SALON_DISCOVERY_EDITOR_ENABLED)
          fail(404, "FEATURE_DISABLED", "Редактор каталога временно недоступен");
        await db.query(
          `INSERT INTO salon_discovery_profiles(tenant_id,draft,draft_version,updated_at)
           VALUES($1,$2,1,now()) ON CONFLICT(tenant_id) DO UPDATE
           SET draft=EXCLUDED.draft,draft_version=salon_discovery_profiles.draft_version+1,updated_at=now()`,
          [t.id, JSON.stringify(b.discovery)],
        );
        const location = b.discovery;
        const geoStatus = location.latitude === null ? "draft" : "pending";
        await db.query(
          `INSERT INTO salon_locations(tenant_id,draft_latitude,draft_longitude,draft_address,draft_city,draft_district,draft_metro_stations,draft_geo_status)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id) DO UPDATE SET
             draft_latitude=EXCLUDED.draft_latitude,draft_longitude=EXCLUDED.draft_longitude,draft_address=EXCLUDED.draft_address,
             draft_city=EXCLUDED.draft_city,draft_district=EXCLUDED.draft_district,draft_metro_stations=EXCLUDED.draft_metro_stations,
             draft_geo_status=EXCLUDED.draft_geo_status,verified_by=NULL,verified_at=NULL`,
          [t.id, location.latitude, location.longitude, location.address, location.city, location.district, location.metroStations, geoStatus],
        );
      }
      if (b.socialLinks) {
        if (!config.SALON_DISCOVERY_EDITOR_ENABLED)
          fail(404, "FEATURE_DISABLED", "Редактор каталога временно недоступен");
        const submittedIds = b.socialLinks.map((link) => link.id ?? randomUUID());
        for (let index = 0; index < b.socialLinks.length; index++) {
          const link = b.socialLinks[index]!;
          const linkId = submittedIds[index]!;
          if (link.id && !(await one(db, "SELECT id FROM salon_social_links WHERE id=$1 AND tenant_id=$2", [link.id, t.id])))
            required(undefined);
          const validated = validateSocialLink(link.kind, link.url);
          if (!validated.ok) fail(422, "INVALID_SOCIAL_LINK", validated.reason, { index });
          await db.query(
            `INSERT INTO salon_social_links(id,tenant_id,kind,draft_url,draft_label,draft_sort_order,draft_validation_status,updated_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(id) DO UPDATE SET
               kind=EXCLUDED.kind,draft_url=EXCLUDED.draft_url,draft_label=EXCLUDED.draft_label,
               draft_sort_order=EXCLUDED.draft_sort_order,draft_validation_status=EXCLUDED.draft_validation_status,updated_at=now()
             WHERE salon_social_links.tenant_id=EXCLUDED.tenant_id`,
            [linkId, t.id, link.kind, validated.url, link.label, link.sortOrder, validated.validationStatus],
          );
        }
        const keepIds = submittedIds;
        await db.query(
          `UPDATE salon_social_links SET draft_url=NULL,updated_at=now() WHERE tenant_id=$1 AND NOT(id=ANY($2::uuid[]))`,
          [t.id, keepIds],
        );
      }
      await audit(db, t.id, actor.id, "storefront.draft", t.id);
      return one(
        db,
        "UPDATE tenants SET draft_style=$2,version=version+1 WHERE id=$1 RETURNING *",
        [t.id, JSON.stringify(b.style)],
      );
    },
  );
  route(
    app,
    "POST",
    "/api/v1/work/:t/storefront/publish",
    {
      roles: ["owner"],
      schema: expected,
      description: "Публикация сохранённого оформления",
    },
    async ({ db, actor, p, b }) => {
      const t = await tenantById(db, p.t!);
      version(t, b.expectedVersion);
      await audit(db, t.id, actor.id, "storefront.published", t.id);
      return publishStyle(db, t);
    },
  );
  route(
    app,
    "POST",
    "/api/v1/work/:t/storefront/avatar",
    {
      roles: ["owner"],
      schema: expected.extend({ mediaId: id }).strict(),
      description: "Немедленная замена логотипа салона без публикации остального черновика",
    },
    async ({ db, actor, p, b }) => {
      const t = await tenantById(db, p.t!);
      version(t, b.expectedVersion);
      await publishCatalogMedia(db, t.id, b.mediaId, "logo");
      await audit(db, t.id, actor.id, "storefront.avatar", b.mediaId);
      return one(
        db,
        "UPDATE tenants SET draft_style=$2,published_style=$3,version=version+1 WHERE id=$1 RETURNING *",
        [
          t.id,
          JSON.stringify({ ...t.draft_style, logoMediaId: b.mediaId }),
          JSON.stringify({ ...t.published_style, logoMediaId: b.mediaId }),
        ],
      );
    },
  );
  route(
    app,
    "GET",
    "/api/v1/admin/salon-discovery/review-queue",
    { description: "Очередь проверки точек и ссылок каталога", noIdempotency: true },
    async ({ db, actor }) => {
      const allowed = new Set(config.PLATFORM_ADMIN_MAX_IDS.split(",").map((value) => value.trim()).filter(Boolean));
      if (!allowed.has(actor.max_user_id)) fail(403, "FORBIDDEN", "Недостаточно прав");
      return {
        items: await rows(db,
          `SELECT t.id,t.name,t.public_code,t.version,l.draft_address,l.draft_city,l.draft_district,
             l.draft_latitude,l.draft_longitude,l.draft_geo_status,
             coalesce(jsonb_agg(jsonb_build_object('id',sl.id,'kind',sl.kind,'url',sl.draft_url,'label',sl.draft_label))
               FILTER(WHERE sl.draft_url IS NOT NULL AND sl.draft_validation_status='pending'),'[]'::jsonb) pending_links
           FROM tenants t LEFT JOIN salon_locations l ON l.tenant_id=t.id
           LEFT JOIN salon_social_links sl ON sl.tenant_id=t.id
           WHERE t.status='published' AND (l.draft_geo_status='pending' OR sl.draft_validation_status='pending')
           GROUP BY t.id,l.tenant_id ORDER BY t.name LIMIT 100`),
      };
    },
  );
  route(
    app,
    "POST",
    "/api/v1/admin/salons/:t/discovery-review",
    {
      schema: expected.extend({
        geoStatus: z.enum(["verified", "rejected"]).optional(),
        approvedLinkIds: z.array(id).max(7).default([]),
        rejectedLinkIds: z.array(id).max(7).default([]),
        rejectionReason: z.string().trim().max(500).default(""),
      }).strict(),
      description: "Решение модератора о координатах и ссылках",
    },
    async ({ db, actor, p, b }) => {
      const allowed = new Set(config.PLATFORM_ADMIN_MAX_IDS.split(",").map((value) => value.trim()).filter(Boolean));
      if (!allowed.has(actor.max_user_id)) fail(403, "FORBIDDEN", "Недостаточно прав");
      if (new Set([...b.approvedLinkIds, ...b.rejectedLinkIds]).size !== b.approvedLinkIds.length + b.rejectedLinkIds.length)
        fail(422, "VALIDATION_ERROR", "Ссылка не может быть одновременно одобрена и отклонена");
      const t = await tenantById(db, p.t!);
      version(t, b.expectedVersion);
      if (b.geoStatus) {
        const location = await one<{ draft_latitude: number | null; draft_longitude: number | null }>(
          db, "SELECT draft_latitude,draft_longitude FROM salon_locations WHERE tenant_id=$1", [t.id]);
        if (!location || location.draft_latitude === null || location.draft_longitude === null)
          fail(422, "LOCATION_REQUIRED", "Сначала салон должен указать точку на карте");
        await db.query(
          `UPDATE salon_locations SET draft_geo_status=$2,verified_by=$3,verified_at=now() WHERE tenant_id=$1`,
          [t.id, b.geoStatus, actor.id]);
      }
      for (const [ids, status] of [[b.approvedLinkIds, "approved"], [b.rejectedLinkIds, "rejected"]] as const) {
        if (!ids.length) continue;
        const result = await db.query(
          `UPDATE salon_social_links SET draft_validation_status=$3,rejection_reason=$4,updated_at=now()
           WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND draft_url IS NOT NULL`,
          [t.id, ids, status, status === "rejected" ? b.rejectionReason || "Не прошла проверку" : null]);
        if (result.rowCount !== ids.length) fail(404, "NOT_FOUND", "Одна из ссылок не найдена в этом салоне");
      }
      await audit(db, t.id, actor.id, "discovery.reviewed", t.id, {
        geoStatus: b.geoStatus ?? null, approvedLinkIds: b.approvedLinkIds, rejectedLinkIds: b.rejectedLinkIds,
      });
      return tenantById(db, t.id);
    },
  );
  for (const action of ["publish", "pause", "archive", "restore"])
    route(
      app,
      "POST",
      `/api/v1/work/:t/${action}`,
      {
        roles: ["owner"],
        schema: expected,
        description: `Изменение статуса салона: ${action}`,
      },
      async ({ db, actor, p, b }) => {
        const t = await tenantById(db, p.t!);
        version(t, b.expectedVersion);
        const allowed: Record<string, string[]> = {
          publish: ["draft", "paused"],
          pause: ["published"],
          archive: ["draft", "paused"],
          restore: ["archived"],
        };
        if (!allowed[action]!.includes(t.status))
          fail(409, "INVALID_STATE_TRANSITION", "Недопустимый переход статуса");
        if (action === "publish") {
          const checks = await publishCheck(db, t);
          if (checks.some((c) => !c.done))
            fail(422, "ONBOARDING_INCOMPLETE", "Завершите настройку салона", {
              checks,
            });
          await publishStyle(db, t);
        }
        if (
          action === "archive" &&
          (await one(
            db,
            "SELECT 1 WHERE EXISTS(SELECT 1 FROM bookings WHERE tenant_id=$1 AND status='confirmed') OR EXISTS(SELECT 1 FROM vouchers WHERE (source_tenant_id=$1 OR target_tenant_id=$1) AND status IN ('issued','reserved')) OR EXISTS(SELECT 1 FROM campaigns WHERE (source_tenant_id=$1 OR target_tenant_id=$1) AND status IN ('active','proposed'))",
            [t.id],
          ))
        )
          fail(
            409,
            "INVALID_STATE_TRANSITION",
            "У салона остались визиты или партнёрские обязательства",
          );
        await audit(db, t.id, actor.id, `tenant.${action}`, t.id);
        return one(
          db,
          "UPDATE tenants SET status=$2,version=version+1 WHERE id=$1 RETURNING *",
          [
            t.id,
            (
              {
                publish: "published",
                pause: "paused",
                archive: "archived",
                restore: "paused",
              } as Record<string, string>
            )[action],
          ],
        );
      },
    );
  route(
    app,
    "GET",
    "/api/v1/work/:t/entry-link",
    { roles: ["owner"], description: "Ссылка салона и QR PNG" },
    async ({ db, p }) => {
      const t = await tenantById(db, p.t!);
      const url = `https://max.ru/${config.MAX_BOT_NAME}?startapp=s_${t.public_code}`;
      return {
        url,
        browserUrl: `${config.PUBLIC_APP_URL}/s/${t.public_code}`,
        qrDataUrl: await QRCode.toDataURL(url, { width: 400, margin: 2 }),
      };
    },
  );
  route(
    app,
    "POST",
    "/api/v1/work/:t/media",
    {
      roles: catalogMedia,
      noIdempotency: true,
      description: "Загрузка и безопасное перекодирование изображения",
    },
    async ({ db, actor, member, p, request }) => {
      const file = await request.file({
        limits: { fileSize: 5 * 1024 * 1024, files: 1 },
      });
      if (!file) fail(422, "VALIDATION_ERROR", "Выберите изображение");
      const purposeField = file.fields.purpose;
      const purpose = z
        .enum(["logo", "cover", "staff", "service", "gallery"])
        .parse(
          purposeField &&
            !Array.isArray(purposeField) &&
            purposeField.type === "field"
            ? purposeField.value
            : undefined,
        );
      if (
        (member.role === "admin" &&
          !["staff", "service", "gallery"].includes(purpose)) ||
        (member.role === "master" && purpose !== "staff")
      )
        fail(
          403,
          "FORBIDDEN",
          "Для этой роли доступна только загрузка изображений каталога",
        );
      const bytes = await file.toBuffer();
      let output: Buffer;
      try {
        const image = sharp(bytes, { limitInputPixels: 20000000 });
        const meta = await image.metadata();
        if (!["jpeg", "png", "webp"].includes(meta.format ?? ""))
          fail(422, "VALIDATION_ERROR", "Разрешены JPEG, PNG, WebP");
        const sizes = {
          logo: [512, 512],
          cover: [1600, 900],
          staff: [800, 800],
          service: [1200, 800],
          gallery: [1600, 1200],
        }[purpose]!;
        output = await image
          .rotate()
          .resize(sizes[0], sizes[1], {
            fit: "cover",
            withoutEnlargement: true,
          })
          .webp({ quality: 85 })
          .toBuffer();
      } catch {
        fail(
          422,
          "VALIDATION_ERROR",
          "Изображение повреждено, слишком велико или имеет неподдерживаемый формат",
        );
      }
      const fileKey = `${randomBytes(24).toString("hex")}.webp`;
      await mkdir(path.join(config.MEDIA_ROOT, "private"), { recursive: true });
      await writeFile(
        path.join(config.MEDIA_ROOT, "private", fileKey),
        output!,
      );
      const media = await one<{ id: string }>(
        db,
        "INSERT INTO media_assets(tenant_id,purpose,file_key) VALUES($1,$2,$3) RETURNING id,file_key,purpose",
        [p.t, purpose, fileKey],
      );
      await audit(db, p.t!, actor.id, "media.uploaded", media!.id);
      return media;
    },
  );
  route(
    app,
    "GET",
    "/api/v1/work/:t/media/:id",
    {
      roles: catalogMedia,
      raw: true,
      description: "Защищённый просмотр чернового изображения",
    },
    async ({ db, member, p, reply }) => {
      const media = required(
        await one<{ file_key: string; purpose: string }>(
          db,
          "SELECT file_key,purpose FROM media_assets WHERE id=$1 AND tenant_id=$2",
          [p.id, p.t],
        ),
      );
      if (
        (member.role === "admin" &&
          !["staff", "service", "gallery"].includes(media.purpose)) ||
        (member.role === "master" && media.purpose !== "staff")
      )
        fail(403, "FORBIDDEN", "Недостаточно прав");
      reply
        .type("image/webp")
        .header("Cache-Control", "private, no-store")
        .send(
          await readFile(
            path.join(config.MEDIA_ROOT, "private", media.file_key),
          ),
        );
    },
  );
  route(
    app,
    "GET",
    "/media/:key",
    {
      public: true,
      raw: true,
      description: "Только опубликованные изображения",
    },
    async ({ db, p, reply }) => {
      if (!/^[a-f0-9]{48}\.webp$/.test(p.key!))
        fail(404, "NOT_FOUND", "Изображение не найдено");
      required(
        await one(
          db,
          "SELECT 1 FROM media_assets WHERE file_key=$1 AND published",
          [p.key],
        ),
      );
      reply
        .type("image/webp")
        .header("Cache-Control", "public,max-age=31536000,immutable")
        .send(
          await readFile(path.join(config.MEDIA_ROOT, "published", p.key!)),
        );
    },
  );
  catalogRoutes(app);
}

function catalogRoutes(app: FastifyInstance) {
  route(
    app,
    "GET",
    "/api/v1/work/:t/my-staff-profile",
    { roles: ["master"], description: "Профиль текущего мастера" },
    async ({ db, member, p }) =>
      required(
        await one<Staff>(
          db,
          `SELECT s.*,rr.rating_average,COALESCE(rr.rating_count,0) rating_count
           FROM staff s
           LEFT JOIN LATERAL (
             SELECT round(avg(vr.rating)::numeric,1)::float8 rating_average,count(*)::int rating_count
             FROM visit_reviews vr
             WHERE vr.tenant_id=s.tenant_id AND vr.staff_id=s.id AND vr.status='active'
           ) rr ON true
           WHERE s.tenant_id=$1 AND s.membership_id=$2 AND s.active`,
          [p.t, member.id],
        ),
      ),
  );
  route(
    app,
    "PATCH",
    "/api/v1/work/:t/my-staff-profile",
    {
      roles: ["master"],
      schema: expected
        .extend({ photoMediaId: id.nullable() })
        .strict(),
      description: "Обновить фотографию текущего мастера",
    },
    async ({ db, actor, member, p, b }) => {
      const current = required(
        await one<Staff>(
          db,
          "SELECT * FROM staff WHERE tenant_id=$1 AND membership_id=$2 AND active",
          [p.t, member.id],
        ),
      );
      version(current, b.expectedVersion);
      await publishCatalogMedia(db, p.t!, b.photoMediaId, "staff");
      const updated = await one<Staff>(
        db,
        "UPDATE staff SET photo_media_id=$2,version=version+1 WHERE id=$1 RETURNING *",
        [current.id, b.photoMediaId],
      );
      await audit(db, p.t!, actor.id, "catalog.staff_photo_updated", current.id);
      return updated;
    },
  );
  route(
    app,
    "GET",
    "/api/v1/work/:t/categories",
    { roles: manage, description: "Категории услуг" },
    async ({ db, p }) =>
      list(
        await rows(
          db,
          "SELECT * FROM categories WHERE tenant_id=$1 ORDER BY sort_order,name",
          [p.t],
        ),
      ),
  );
  route(
    app,
    "POST",
    "/api/v1/work/:t/categories",
    {
      roles: manage,
      schema: z
        .object({ name: text, sortOrder: z.number().int().min(0).default(0) })
        .strict(),
      description: "Создать категорию",
    },
    async ({ db, actor, p, b }) => {
      const result = (await one<{ id: string }>(
        db,
        "INSERT INTO categories(tenant_id,name,sort_order) VALUES($1,$2,$3) RETURNING *",
        [p.t, b.name, b.sortOrder],
      ))!;
      await audit(db, p.t!, actor.id, "catalog.category_created", result.id);
      return result;
    },
  );
  route(
    app,
    "PATCH",
    "/api/v1/work/:t/categories/:id",
    {
      roles: manage,
      schema: expected
        .extend({ name: text, sortOrder: z.number().int().min(0) })
        .strict(),
      description: "Изменить категорию",
    },
    async ({ db, p, b }) => {
      version(
        required(
          await one<{ version: number }>(
            db,
            "SELECT version FROM categories WHERE id=$1 AND tenant_id=$2",
            [p.id, p.t],
          ),
        ),
        b.expectedVersion,
      );
      return one(
        db,
        "UPDATE categories SET name=$2,sort_order=$3,version=version+1 WHERE id=$1 RETURNING *",
        [p.id, b.name, b.sortOrder],
      );
    },
  );
  for (const entity of ["services", "staff"] as const) {
    route(
      app,
      "GET",
      `/api/v1/work/:t/${entity}`,
      { roles: manage, description: `Рабочий каталог ${entity}` },
      async ({ db, p }) =>
        list(
          await rows(
            db,
            entity === "staff"
              ? `SELECT s.*,
                        COALESCE(array_agg(ss.service_id) FILTER(WHERE ss.service_id IS NOT NULL),'{}') service_ids,
                        rr.rating_average,COALESCE(rr.rating_count,0) rating_count
                 FROM staff s
                 LEFT JOIN staff_services ss ON ss.staff_id=s.id
                 LEFT JOIN LATERAL (
                   SELECT round(avg(vr.rating)::numeric,1)::float8 rating_average,count(*)::int rating_count
                   FROM visit_reviews vr
                   WHERE vr.tenant_id=s.tenant_id AND vr.staff_id=s.id AND vr.status='active'
                 ) rr ON true
                 WHERE s.tenant_id=$1
                 GROUP BY s.id,rr.rating_average,rr.rating_count ORDER BY s.name`
              : "SELECT * FROM services WHERE tenant_id=$1 ORDER BY name",
            [p.t],
          ),
        ),
    );
    if (entity === "services") {
      route(
        app,
        "POST",
        "/api/v1/work/:t/services",
        { roles: manage, schema: service, description: "Создание услуги" },
        async ({ db, actor, p, b }) => {
          const result = (await one<Service>(
            db,
            "INSERT INTO services(tenant_id,name,description,category_id,duration_min,price_minor,cover_media_id,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
            [
              p.t,
              b.name,
              b.description,
              b.categoryId ?? null,
              b.durationMin,
              b.priceMinor,
              b.coverMediaId ?? null,
              b.active,
            ],
          ))!;
          await publishCatalogMedia(db, p.t!, b.coverMediaId, "service");
          await audit(db, p.t!, actor.id, "catalog.service_created", result.id);
          return result;
        },
      );
      route(
        app,
        "PATCH",
        "/api/v1/work/:t/services/:id",
        {
          roles: manage,
          schema: service
            .extend({ expectedVersion: z.number().int().positive() })
            .strict(),
          description: "Изменение услуги для будущих записей",
        },
        async ({ db, actor, p, b }) => {
          version(
            required(
              await one<Service>(
                db,
                "SELECT * FROM services WHERE id=$1 AND tenant_id=$2",
                [p.id, p.t],
              ),
            ),
            b.expectedVersion,
          );
          await publishCatalogMedia(db, p.t!, b.coverMediaId, "service");
          await audit(db, p.t!, actor.id, "catalog.service_updated", p.id!);
          return one(
            db,
            "UPDATE services SET name=$2,description=$3,category_id=$4,duration_min=$5,price_minor=$6,cover_media_id=$7,active=$8,version=version+1 WHERE id=$1 RETURNING *",
            [
              p.id,
              b.name,
              b.description,
              b.categoryId ?? null,
              b.durationMin,
              b.priceMinor,
              b.coverMediaId ?? null,
              b.active,
            ],
          );
        },
      );
    } else {
      route(
        app,
        "POST",
        "/api/v1/work/:t/staff",
        { roles: manage, schema: staff, description: "Создание мастера" },
        async ({ db, actor, p, b }) => {
          const result = (await one<Staff>(
            db,
            "INSERT INTO staff(tenant_id,name,description,photo_media_id,active) VALUES($1,$2,$3,$4,$5) RETURNING *",
            [p.t, b.name, b.description, b.photoMediaId ?? null, b.active],
          ))!;
          await publishCatalogMedia(db, p.t!, b.photoMediaId, "staff");
          await audit(db, p.t!, actor.id, "catalog.staff_created", result.id);
          return result;
        },
      );
      route(
        app,
        "PATCH",
        "/api/v1/work/:t/staff/:id",
        {
          roles: manage,
          schema: staff
            .extend({ expectedVersion: z.number().int().positive() })
            .strict(),
          description: "Изменение мастера",
        },
        async ({ db, actor, p, b }) => {
          version(
            required(
              await one<Staff>(
                db,
                "SELECT * FROM staff WHERE id=$1 AND tenant_id=$2",
                [p.id, p.t],
              ),
            ),
            b.expectedVersion,
          );
          await publishCatalogMedia(db, p.t!, b.photoMediaId, "staff");
          await audit(db, p.t!, actor.id, "catalog.staff_updated", p.id!);
          return one(
            db,
            "UPDATE staff SET name=$2,description=$3,active=$4,photo_media_id=$5,version=version+1 WHERE id=$1 RETURNING *",
            [p.id, b.name, b.description, b.active, b.photoMediaId ?? null],
          );
        },
      );
    }
    route(
      app,
      "POST",
      `/api/v1/work/:t/${entity}/:id/archive`,
      {
        roles: manage,
        schema: expected,
        description: "Архивирование с сохранением истории",
      },
      async ({ db, actor, p, b }) => {
        version(
          required(
            await one<{ version: number }>(
              db,
              `SELECT version FROM ${entity} WHERE id=$1 AND tenant_id=$2`,
              [p.id, p.t],
            ),
          ),
          b.expectedVersion,
        );
        await audit(db, p.t!, actor.id, `catalog.${entity}_archived`, p.id!);
        return one(
          db,
          `UPDATE ${entity} SET active=false,version=version+1 WHERE id=$1 RETURNING *`,
          [p.id],
        );
      },
    );
  }
  route(
    app,
    "PUT",
    "/api/v1/work/:t/staff/:id/services",
    {
      roles: manage,
      schema: expected.extend({ serviceIds: z.array(id).max(100) }).strict(),
      description: "Назначить услуги мастеру",
    },
    async ({ db, actor, p, b }) => {
      version(
        required(
          await one<Staff>(
            db,
            "SELECT * FROM staff WHERE id=$1 AND tenant_id=$2",
            [p.id, p.t],
          ),
        ),
        b.expectedVersion,
      );
      await db.query("DELETE FROM staff_services WHERE staff_id=$1", [p.id]);
      for (const serviceId of new Set(b.serviceIds))
        await db.query(
          "INSERT INTO staff_services(tenant_id,staff_id,service_id) VALUES($1,$2,$3)",
          [p.t, p.id, serviceId],
        );
      await audit(db, p.t!, actor.id, "catalog.staff_services", p.id!);
      return one(
        db,
        "UPDATE staff SET version=version+1 WHERE id=$1 RETURNING *",
        [p.id],
      );
    },
  );
  route(
    app,
    "GET",
    "/api/v1/work/:t/staff/:id/schedule",
    {
      roles: ["owner", "admin", "master"],
      description: "Недельные правила и исключения мастера",
    },
    async ({ db, member, p }) => {
      const s = required(
        await one<Staff>(
          db,
          "SELECT * FROM staff WHERE id=$1 AND tenant_id=$2",
          [p.id, p.t],
        ),
      );
      if (member.role === "master" && s.membership_id !== member.id)
        fail(404, "NOT_FOUND", "График недоступен");
      return {
        staff: s,
        rules: await rows(
          db,
          "SELECT * FROM schedules WHERE staff_id=$1 ORDER BY effective_from DESC,version DESC",
          [s.id],
        ),
        exceptions: await rows(
          db,
          "SELECT *,local_date::text date FROM schedule_exceptions WHERE staff_id=$1 ORDER BY local_date",
          [s.id],
        ),
      };
    },
  );
  route(
    app,
    "PUT",
    "/api/v1/work/:t/staff/:id/schedule",
    {
      roles: manage,
      schema: schedule,
      description: "Версионный недельный график с подтверждением конфликтов",
    },
    async ({ db, actor, p, b }) => {
      const s = required(
        await one<Staff>(
          db,
          "SELECT * FROM staff WHERE id=$1 AND tenant_id=$2",
          [p.id, p.t],
        ),
      );
      version(s, b.expectedVersion);
      const t = await tenantById(db, p.t!);
      if (b.effectiveFrom <= DateTime.now().setZone(t.timezone).toISODate()!)
        fail(
          422,
          "VALIDATION_ERROR",
          "Новая версия графика действует с завтрашнего дня или позднее",
        );
      if (new Set(b.weekly.map((w) => w.weekday)).size !== b.weekly.length)
        fail(422, "VALIDATION_ERROR", "Дни недели не должны повторяться");
      for (const day of b.weekly) validateIntervals(day.intervals);
      const future = await rows<Booking>(
        db,
        "SELECT * FROM bookings WHERE staff_id=$1 AND status='confirmed' AND start_at >= $2::date AT TIME ZONE $3",
        [s.id, b.effectiveFrom, t.timezone],
      );
      const conflicts = future.filter((booking) => {
        const date = DateTime.fromJSDate(booking.start_at, {
          zone: t.timezone,
        });
        return !utcIntervals(
          date.toISODate()!,
          t.timezone,
          b.weekly.find((w) => w.weekday === date.weekday)?.intervals ?? [],
        ).some(
          ([a, z]) =>
            a <= booking.start_at.getTime() && z >= booking.end_at.getTime(),
        );
      });
      if (conflicts.length && !b.confirmConflicts)
        fail(
          409,
          "SCHEDULE_CONFLICTS",
          "Новый график не покрывает существующие визиты. Они сохранятся; подтвердите изменение.",
          { bookingIds: conflicts.map((v) => v.id) },
        );
      await db.query(
        "INSERT INTO schedules(tenant_id,staff_id,effective_from,weekly,version) VALUES($1,$2,$3,$4,$5)",
        [p.t, p.id, b.effectiveFrom, JSON.stringify(b.weekly), s.version + 1],
      );
      const result = await one(
        db,
        "UPDATE staff SET version=version+1 WHERE id=$1 RETURNING *",
        [p.id],
      );
      await snapshotDays(db, t, s.id, b.effectiveFrom);
      await audit(db, p.t!, actor.id, "schedule.updated", s.id, {
        conflicts: conflicts.map((c) => c.id),
      });
      return result;
    },
  );
  route(
    app,
    "PUT",
    "/api/v1/work/:t/staff/:id/exceptions/:date",
    {
      roles: manage,
      schema: expected
        .extend({
          mode: z.enum(["closed", "replace"]),
          intervals: z.array(interval).max(16),
          confirmConflicts: z.boolean().default(false),
        })
        .strict(),
      description: "Закрыть день или заменить интервалы",
    },
    async ({ db, actor, p, b }) => {
      const s = required(
        await one<Staff>(
          db,
          "SELECT * FROM staff WHERE id=$1 AND tenant_id=$2",
          [p.id, p.t],
        ),
      );
      version(s, b.expectedVersion);
      const t = await tenantById(db, p.t!);
      date.parse(p.date);
      if (p.date! <= DateTime.now().setZone(t.timezone).toISODate()!)
        fail(422, "VALIDATION_ERROR", "Исключения доступны для будущих дней");
      validateIntervals(b.intervals);
      const bookings = await rows<Booking>(
        db,
        "SELECT * FROM bookings WHERE staff_id=$1 AND status='confirmed' AND (start_at AT TIME ZONE $3)::date=$2::date",
        [s.id, p.date, t.timezone],
      );
      const ranges =
        b.mode === "closed"
          ? []
          : utcIntervals(p.date!, t.timezone, b.intervals);
      const conflicts = bookings.filter(
        (v) =>
          !ranges.some(
            ([a, z]) => a <= v.start_at.getTime() && z >= v.end_at.getTime(),
          ),
      );
      if (conflicts.length && !b.confirmConflicts)
        fail(
          409,
          "SCHEDULE_CONFLICTS",
          "В этот день есть записи. Подтвердите изменение графика без отмены записей.",
          { bookingIds: conflicts.map((v) => v.id) },
        );
      await db.query(
        "INSERT INTO schedule_exceptions(tenant_id,staff_id,local_date,mode,intervals) VALUES($1,$2,$3,$4,$5) ON CONFLICT(staff_id,local_date) DO UPDATE SET mode=$4,intervals=$5,version=schedule_exceptions.version+1",
        [p.t, p.id, p.date, b.mode, JSON.stringify(b.intervals)],
      );
      await snapshotDays(db, t, s.id, p.date!, 1);
      await audit(db, p.t!, actor.id, "schedule.exception", s.id, {
        date: p.date,
      });
      return one(
        db,
        "UPDATE staff SET version=version+1 WHERE id=$1 RETURNING *",
        [s.id],
      );
    },
  );
  route(
    app,
    "DELETE",
    "/api/v1/work/:t/staff/:id/exceptions/:date",
    {
      roles: manage,
      schema: expected,
      description: "Удаление исключения и возврат недельного графика",
    },
    async ({ db, actor, p, b }) => {
      const s = required(
        await one<Staff>(
          db,
          "SELECT * FROM staff WHERE id=$1 AND tenant_id=$2",
          [p.id, p.t],
        ),
      );
      version(s, b.expectedVersion);
      const t = await tenantById(db, p.t!);
      date.parse(p.date);
      if (p.date! <= DateTime.now().setZone(t.timezone).toISODate()!)
        fail(422, "VALIDATION_ERROR", "Прошедший график нельзя менять");
      await db.query(
        "DELETE FROM schedule_exceptions WHERE staff_id=$1 AND local_date=$2",
        [s.id, p.date],
      );
      await snapshotDays(db, t, s.id, p.date!, 1);
      await audit(db, p.t!, actor.id, "schedule.exception_removed", s.id, {
        date: p.date,
      });
      return one(
        db,
        "UPDATE staff SET version=version+1 WHERE id=$1 RETURNING *",
        [s.id],
      );
    },
  );
}
