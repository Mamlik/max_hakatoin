import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DateTime, IANAZone } from "luxon";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import QRCode from "qrcode";
import { route, audit, list } from "./http.js";
import { one, rows, type DB } from "../db/db.js";
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
} from "../contracts/schemas.js";
import type {
  Tenant,
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

const manage = ["owner", "admin"] as ("owner" | "admin")[];
const catalogMedia = ["owner", "admin", "master"] as (
  | "owner"
  | "admin"
  | "master"
)[];
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
  return [
    {
      key: "profile",
      label: "Профиль и контакт",
      done: !!tenant.name && !!tenant.address && !!tenant.contact,
    },
    { key: "service", label: "Активная услуга", done: hasService },
    { key: "staff", label: "Мастер, оказывающий услугу", done: hasStaff },
    { key: "schedule", label: "Рабочий график", done: hasSchedule },
  ];
}
async function publishStyle(db: DB, tenant: Tenant) {
  for (const asset of [
    tenant.draft_style.logoMediaId,
    tenant.draft_style.coverMediaId,
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
    "UPDATE tenants SET published_style=draft_style,published_profile=$2,version=version+1 WHERE id=$1 RETURNING *",
    [
      tenant.id,
      JSON.stringify({
        name: tenant.name,
        category: tenant.category,
        address: tenant.address,
        contact: tenant.contact,
        timezone: tenant.timezone,
      }),
    ],
  );
}
async function publishCatalogMedia(
  db: DB,
  tenantId: string,
  mediaId: string | null | undefined,
  purpose: "staff" | "service",
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
  return {
    id: tenant.id,
    publicCode: tenant.public_code,
    ...tenant.published_profile,
    style: tenant.published_style,
    media: assets,
    partnerEnabled: tenant.partner_enabled,
  };
}
export function salonRoutes(app: FastifyInstance) {
  route(
    app,
    "GET",
    "/api/v1/public/salons",
    {
      public: true,
      description: "Поиск опубликованных салонов по названию, коду, категории и активным услугам",
    },
    async ({ db, q }) => {
      const result = await rows<Tenant>(
        db,
        `SELECT t.* FROM tenants t WHERE t.status='published' AND
          ($1='' OR lower(t.published_profile->>'name') LIKE '%'||lower($1)||'%'
           OR lower(t.published_profile->>'category') LIKE '%'||lower($1)||'%'
           OR lower(t.published_profile->>'address') LIKE '%'||lower($1)||'%'
           OR lower(t.public_code)=lower($1)
           OR EXISTS (SELECT 1 FROM services s WHERE s.tenant_id=t.id AND s.active=true
             AND (lower(s.name) LIKE '%'||lower($1)||'%' OR lower(s.description) LIKE '%'||lower($1)||'%')))
         ORDER BY t.name LIMIT 100`,
        [(q.query ?? "").slice(0, 120)],
      );
      return list(await Promise.all(result.map((t) => publicSalon(db, t))));
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
      { roles: ["owner"], description: "Черновик и предпросмотр оформления" },
      async ({ db, p }) => {
        const t = await tenantById(db, p.t!);
        return {
          ...t,
          style: t.draft_style,
          media: await rows(
            db,
            "SELECT id,file_key,purpose FROM media_assets WHERE tenant_id=$1",
            [p.t],
          ),
        };
      },
    );
  route(
    app,
    "PUT",
    "/api/v1/work/:t/storefront/draft",
    {
      roles: ["owner"],
      schema: expected.extend({ style }).strict(),
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
        .enum(["logo", "cover", "staff", "service"])
        .parse(
          purposeField &&
            !Array.isArray(purposeField) &&
            purposeField.type === "field"
            ? purposeField.value
            : undefined,
        );
      if (
        (member.role === "admin" &&
          !["staff", "service"].includes(purpose)) ||
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
          !["staff", "service"].includes(media.purpose)) ||
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
