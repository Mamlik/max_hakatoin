import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { route, audit, list, page } from "./http.js";
import { hash, randomToken, validateInitData, signInitData } from "./auth.js";
import { one, rows } from "../db/db.js";
import { required, fail, version } from "./errors.js";
import { config } from "./config.js";
import { empty, expected, id, text } from "../contracts/schemas.js";
import type { Actor, Membership, Tenant } from "./types.js";
import { publicSalon } from "./salons.routes.js";

export function identityRoutes(app: FastifyInstance) {
  route(
    app,
    "POST",
    "/api/v1/auth/max",
    {
      public: true,
      schema: z.object({ initData: z.string().max(16384) }).strict(),
      description: "Проверка подписи MAX и создание сессии со скользящим сроком",
    },
    async ({ db, b }) => {
      const max = validateInitData(b.initData);
      const user = (await one<Actor>(
        db,
        "INSERT INTO users(max_user_id,display_name) VALUES($1,$2) ON CONFLICT(max_user_id) DO UPDATE SET max_user_id=EXCLUDED.max_user_id RETURNING *",
        [max.id, max.name],
      ))!;
      const token = randomToken();
      const expiresAt = new Date(
        Date.now() + config.SESSION_IDLE_SECONDS * 1000,
      );
      await db.query(
        "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)",
        [user.id, hash(token), expiresAt],
      );
      return {
        sessionToken: token,
        expiresAt,
        user,
        launchContext: max.startParam,
      };
    },
  );
  // This issuer only exists in the local demo profile. It produces signed data, not privileged sessions.
  if (
    config.MAX_MODE === "mock" &&
    ["local", "demo", "test"].includes(config.APP_ENV)
  )
    route(
      app,
      "POST",
      "/api/v1/demo/identity",
      {
        public: true,
        schema: z
          .object({
            persona: z.enum([
              "client",
              "owner-a",
              "owner-b",
              "admin",
              "master",
              "new-owner",
            ]),
          })
          .strict(),
        description: "Локальный mock issuer (отсутствует в production)",
      },
      async ({ b }) => {
        const personas = {
          client: ["900001", "Анна", "Клиент"],
          "owner-a": ["900002", "Мария", "Владелец A"],
          "owner-b": ["900003", "Елена", "Владелец B"],
          admin: ["900004", "Ольга", "Администратор"],
          master: ["900005", "София", "Мастер"],
          "new-owner": ["900006", "Новый", "Владелец"],
        };
        const p = personas[b.persona];
        return {
          initData: signInitData({
            auth_date: String(Math.floor(Date.now() / 1000)),
            user: JSON.stringify({
              id: p[0],
              first_name: p[1],
              last_name: p[2],
            }),
          }),
        };
      },
    );
  route(
    app,
    "GET",
    "/api/v1/config",
    { public: true, description: "Публичная конфигурация приложения" },
    async () => ({
      demo: config.MAX_MODE === "mock",
      botName: config.MAX_BOT_NAME,
      appUrl: config.PUBLIC_APP_URL,
      storefrontThemesV2: config.STOREFRONT_THEMES_V2,
      salonDiscovery: {
        searchEnabled: config.SALON_DISCOVERY_SEARCH_ENABLED,
        mapEnabled: config.SALON_DISCOVERY_MAP_ENABLED,
        editorEnabled: config.SALON_DISCOVERY_EDITOR_ENABLED,
        mapProvider: "openfreemap",
        mapStyleLight: config.SALON_DISCOVERY_MAP_STYLE_LIGHT_URL,
        mapStyleDark: config.SALON_DISCOVERY_MAP_STYLE_DARK_URL,
        geocoderEnabled: config.SALON_DISCOVERY_GEOCODER_ENABLED &&
          (config.SALON_DISCOVERY_GEOCODER_PROVIDER === "nominatim" || !!config.SALON_DISCOVERY_GEOAPIFY_API_KEY),
        geocoderProvider: config.SALON_DISCOVERY_GEOCODER_PROVIDER,
      },
    }),
  );
  route(
    app,
    "GET",
    "/api/v1/me",
    { description: "Профиль, актуальные роли и состояние бота" },
    async ({ db, actor }) => ({
      user: actor,
      memberships: await rows(
        db,
        "SELECT m.*,t.name tenant_name,t.public_code FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=$1 AND m.status='active' ORDER BY t.name",
        [actor.id],
      ),
      channel: (await one(
        db,
        "SELECT state FROM bot_channels WHERE user_id=$1",
        [actor.id],
      )) ?? { state: "unknown" },
    }),
  );
  route(
    app,
    "POST",
    "/api/v1/auth/logout",
    { schema: empty, noIdempotency: true, description: "Завершение сессии" },
    async ({ db, actor }) => {
      await db.query("DELETE FROM sessions WHERE id=$1", [actor.session_id]);
      return { ok: true };
    },
  );
  route(
    app,
    "PATCH",
    "/api/v1/me/profile",
    {
      schema: expected.extend({ displayName: text }).strict(),
      description: "Изменение имени",
    },
    async ({ db, actor, b }) => {
      version(actor, b.expectedVersion);
      return one(
        db,
        "UPDATE users SET display_name=$2,version=version+1 WHERE id=$1 RETURNING *",
        [actor.id, b.displayName],
      );
    },
  );
  route(
    app,
    "PATCH",
    "/api/v1/me/preferences",
    {
      schema: expected
        .extend({
          partnerProgramEnabled: z.boolean(),
          textVersion: z.literal("p0-v1"),
        })
        .strict(),
      description: "Общее согласие на партнёрские предложения",
    },
    async ({ db, actor, b }) => {
      version(actor, b.expectedVersion);
      const result = await one(
        db,
        "UPDATE users SET partner_program_enabled=$2,version=version+1 WHERE id=$1 RETURNING *",
        [actor.id, b.partnerProgramEnabled],
      );
      await db.query(
        "INSERT INTO consent_history(user_id,before_state,after_state) VALUES($1,$2,$3)",
        [
          actor.id,
          JSON.stringify({
            partnerProgramEnabled: actor.partner_program_enabled,
          }),
          JSON.stringify({ partnerProgramEnabled: b.partnerProgramEnabled }),
        ],
      );
      return result;
    },
  );
  route(
    app,
    "GET",
    "/api/v1/me/notification-preferences",
    { description: "Общие сервисные уведомления по салонам и исключения" },
    async ({ db, actor }) => ({
      serviceEnabled: actor.service_notifications_enabled,
      remindersEnabled: actor.reminders_enabled,
      liveWindowEnabled: actor.live_window_notifications_enabled,
      version: actor.version,
      salons: await rows(
        db,
        `SELECT t.id,t.name,
           EXISTS(SELECT 1 FROM notification_exclusions e WHERE e.user_id=$1 AND e.tenant_id=t.id AND e.category='service') excluded_service,
           EXISTS(SELECT 1 FROM notification_exclusions e WHERE e.user_id=$1 AND e.tenant_id=t.id AND e.category='reminder') excluded_reminder,
           EXISTS(SELECT 1 FROM notification_exclusions e WHERE e.user_id=$1 AND e.tenant_id=t.id AND e.category='live_window') excluded_live_window
         FROM tenants t WHERE EXISTS (
           SELECT 1 FROM bookings b WHERE b.tenant_id=t.id
             AND (b.user_id=$1 OR EXISTS(SELECT 1 FROM customers c WHERE c.id=b.customer_id AND c.user_id=$1))
         ) ORDER BY t.name`,
        [actor.id],
      ),
    }),
  );
  route(
    app,
    "PATCH",
    "/api/v1/me/notification-preferences",
    {
      schema: expected.extend({
        serviceEnabled: z.boolean(),
        remindersEnabled: z.boolean(),
        liveWindowEnabled: z.boolean(),
        excludedServiceSalonIds: z.array(z.uuid()).max(500),
        excludedReminderSalonIds: z.array(z.uuid()).max(500),
        excludedLiveWindowSalonIds: z.array(z.uuid()).max(500),
        textVersion: z.literal("notifications-v1"),
      }).strict(),
      description: "Обновление общих сервисных уведомлений и исключений по салонам",
    },
    async ({ db, actor, b }) => {
      version(actor, b.expectedVersion);
      const exclusionSets = [
        ["service", b.excludedServiceSalonIds],
        ["reminder", b.excludedReminderSalonIds],
        ["live_window", b.excludedLiveWindowSalonIds],
      ] as const;
      const allExcludedIds = [...new Set(exclusionSets.flatMap(([, ids]) => ids))];
      if (exclusionSets.some(([, ids]) => new Set(ids).size !== ids.length))
        fail(422, "VALIDATION_ERROR", "Салоны в исключениях не должны повторяться");
      if (allExcludedIds.length) {
        const visitedSalons = await rows<{ id: string }>(
          db,
          `SELECT DISTINCT tenant_id id FROM bookings
           WHERE tenant_id=ANY($2::uuid[])
             AND (user_id=$1 OR EXISTS(SELECT 1 FROM customers c WHERE c.id=bookings.customer_id AND c.user_id=$1))`,
          [actor.id, allExcludedIds],
        );
        if (visitedSalons.length !== allExcludedIds.length)
          fail(422, "SALON_NOT_BOOKED", "В исключения можно добавить только салоны, где у вас была запись");
      }
      const result = await one(
        db,
        `UPDATE users SET service_notifications_enabled=$2,reminders_enabled=$3,
           live_window_notifications_enabled=$4,version=version+1 WHERE id=$1 RETURNING *`,
        [actor.id, b.serviceEnabled, b.remindersEnabled, b.liveWindowEnabled],
      );
      await db.query("DELETE FROM notification_exclusions WHERE user_id=$1", [actor.id]);
      for (const [category, ids] of exclusionSets)
        for (const salonId of ids)
          await db.query(
            "INSERT INTO notification_exclusions(user_id,tenant_id,category) VALUES($1,$2,$3)",
            [actor.id, salonId, category],
          );
      await db.query(
        "INSERT INTO consent_history(user_id,before_state,after_state,text_version) VALUES($1,$2,$3,$4)",
        [
          actor.id,
          JSON.stringify({
            serviceEnabled: actor.service_notifications_enabled,
            remindersEnabled: actor.reminders_enabled,
            liveWindowEnabled: actor.live_window_notifications_enabled,
          }),
          JSON.stringify({
            serviceEnabled: b.serviceEnabled,
            remindersEnabled: b.remindersEnabled,
            liveWindowEnabled: b.liveWindowEnabled,
            excludedServiceSalonIds: b.excludedServiceSalonIds,
            excludedReminderSalonIds: b.excludedReminderSalonIds,
            excludedLiveWindowSalonIds: b.excludedLiveWindowSalonIds,
          }),
          b.textVersion,
        ],
      );
      return result;
    },
  );
  route(
    app,
    "GET",
    "/api/v1/me/marketing-preferences",
    { description: "Глобальное согласие на рекламные предложения и салоны-исключения" },
    async ({ db, actor }) => ({
      enabled: actor.marketing_messages_enabled,
      version: actor.version,
      salons: await rows(
        db,
        `SELECT t.id,t.name,EXISTS(
           SELECT 1 FROM marketing_exclusions e
           WHERE e.user_id=$1 AND e.tenant_id=t.id
         ) excluded
         FROM tenants t
         WHERE EXISTS (
           SELECT 1 FROM bookings b
           WHERE b.tenant_id=t.id
             AND (b.user_id=$1 OR EXISTS(
               SELECT 1 FROM customers c WHERE c.id=b.customer_id AND c.user_id=$1
             ))
         )
         ORDER BY t.name`,
        [actor.id],
      ),
    }),
  );
  route(
    app,
    "PATCH",
    "/api/v1/me/marketing-preferences",
    {
      schema: expected.extend({
        enabled: z.boolean(),
        excludedSalonIds: z.array(z.uuid()).max(500),
        textVersion: z.literal("marketing-v1"),
      }).strict(),
      description: "Сохранение общего согласия на предложения и исключений для посещённых салонов",
    },
    async ({ db, actor, b }) => {
      version(actor, b.expectedVersion);
      const excludedSalonIds = [...new Set(b.excludedSalonIds)];
      if (excludedSalonIds.length !== b.excludedSalonIds.length)
        fail(422, "VALIDATION_ERROR", "Салоны в исключениях не должны повторяться");
      if (excludedSalonIds.length) {
        const eligibleSalons = await rows<{ id: string }>(
          db,
          `SELECT DISTINCT tenant_id id FROM bookings
           WHERE tenant_id=ANY($2::uuid[])
             AND (user_id=$1 OR EXISTS(
               SELECT 1 FROM customers c WHERE c.id=bookings.customer_id AND c.user_id=$1
             ))`,
          [actor.id, excludedSalonIds],
        );
        if (eligibleSalons.length !== excludedSalonIds.length)
          fail(422, "SALON_NOT_BOOKED", "В исключения можно добавить только салоны, где у вас была запись");
      }
      const result = await one(
        db,
        "UPDATE users SET marketing_messages_enabled=$2,version=version+1 WHERE id=$1 RETURNING *",
        [actor.id, b.enabled],
      );
      await db.query("DELETE FROM marketing_exclusions WHERE user_id=$1", [actor.id]);
      for (const salonId of excludedSalonIds)
        await db.query(
          "INSERT INTO marketing_exclusions(user_id,tenant_id) VALUES($1,$2)",
          [actor.id, salonId],
        );
      await db.query(
        "INSERT INTO consent_history(user_id,before_state,after_state,text_version) VALUES($1,$2,$3,$4)",
        [
          actor.id,
          JSON.stringify({ marketingMessagesEnabled: actor.marketing_messages_enabled }),
          JSON.stringify({ marketingMessagesEnabled: b.enabled, excludedSalonIds }),
          b.textVersion,
        ],
      );
      return result;
    },
  );
  route(
    app,
    "GET",
    "/api/v1/me/salons",
    { description: "Салоны с записями и избранные" },
    async ({ db, actor }) => {
      const salons = await rows<Tenant & { favorite: boolean }>(
        db,
        "SELECT t.*, EXISTS(SELECT 1 FROM favorites f WHERE f.user_id=$1 AND f.tenant_id=t.id) favorite FROM tenants t WHERE EXISTS(SELECT 1 FROM favorites f WHERE f.user_id=$1 AND f.tenant_id=t.id) OR EXISTS(SELECT 1 FROM customers c WHERE c.user_id=$1 AND c.tenant_id=t.id)",
        [actor.id],
      );
      return list(
        await Promise.all(
          salons.map(async (salon) => ({
            ...(await publicSalon(db, salon)),
            status: salon.status,
            version: salon.version,
            favorite: salon.favorite,
          })),
        ),
      );
    },
  );
  for (const method of ["PUT", "DELETE"] as const)
    route(
      app,
      method,
      "/api/v1/me/favorites/:t",
      {
        schema: empty,
        description:
          method === "PUT" ? "Добавить в избранное" : "Удалить из избранного",
      },
      async ({ db, actor, p }) => {
        required(
          await one(
            db,
            "SELECT id FROM tenants WHERE id=$1 AND (status='published' OR id IN (SELECT tenant_id FROM favorites WHERE user_id=$2))",
            [p.t, actor.id],
          ),
        );
        if (method === "PUT")
          await db.query(
            "INSERT INTO favorites(user_id,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
            [actor.id, p.t],
          );
        else
          await db.query(
            "DELETE FROM favorites WHERE user_id=$1 AND tenant_id=$2",
            [actor.id, p.t],
          );
        return { ok: true };
      },
    );
  route(
    app,
    "GET",
    "/api/v1/me/salons/:t/preferences",
    { description: "Настройки сообщений и согласия выбранного салона" },
    async ({ db, actor, p }) => {
      required(await one(db, "SELECT id FROM tenants WHERE id=$1", [p.t]));
      return (
        (await one(
          db,
          "SELECT * FROM preferences WHERE user_id=$1 AND tenant_id=$2",
          [actor.id, p.t],
        )) ?? {
          partnerAllowed: false,
          serviceBotEnabled: true,
          reminderBotEnabled: true,
          offerBotEnabled: true,
          version: 0,
        }
      );
    },
  );
  route(
    app,
    "PATCH",
    "/api/v1/me/salons/:t/preferences",
    {
      schema: z
        .object({
          expectedVersion: z.number().int().min(0),
          partnerAllowed: z.boolean(),
          serviceBotEnabled: z.boolean(),
          reminderBotEnabled: z.boolean(),
          offerBotEnabled: z.boolean(),
          textVersion: z.literal("p0-v1"),
        })
        .strict(),
      description: "Сохранение отдельных согласий без автоматической подписки",
    },
    async ({ db, actor, p, b }) => {
      const old = await one<{ version: number }>(
        db,
        "SELECT * FROM preferences WHERE user_id=$1 AND tenant_id=$2",
        [actor.id, p.t],
      );
      version(old ?? { version: 0 }, b.expectedVersion);
      const result = await one(
        db,
        "INSERT INTO preferences(user_id,tenant_id,partner_allowed,service_bot_enabled,reminder_bot_enabled,offer_bot_enabled) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,tenant_id) DO UPDATE SET partner_allowed=$3,service_bot_enabled=$4,reminder_bot_enabled=$5,offer_bot_enabled=$6,version=preferences.version+1 RETURNING *",
        [
          actor.id,
          p.t,
          b.partnerAllowed,
          b.serviceBotEnabled,
          b.reminderBotEnabled,
          b.offerBotEnabled,
        ],
      );
      await db.query(
        "INSERT INTO consent_history(user_id,tenant_id,before_state,after_state) VALUES($1,$2,$3,$4)",
        [actor.id, p.t, JSON.stringify(old ?? {}), JSON.stringify(b)],
      );
      return result;
    },
  );
  route(
    app,
    "GET",
    "/api/v1/me/notifications",
    { description: "Центр событий с фильтром салона, типа и прочтения" },
    async ({ db, actor, q }) => {
      const { limit, offset } = page(q);
      const items = await rows(
        db,
        "SELECT n.*,t.name tenant_name FROM notifications n LEFT JOIN tenants t ON t.id=n.tenant_id WHERE n.user_id=$1 AND n.created_at<=now() AND ($2::uuid IS NULL OR n.tenant_id=$2) AND ($3::text IS NULL OR n.kind LIKE $3||'%') AND ($4::text IS NULL OR ($4='unread' AND n.read_at IS NULL) OR ($4='read' AND n.read_at IS NOT NULL)) AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.notification_id=n.id AND d.category='reminder' AND d.state='suppressed') ORDER BY n.created_at DESC,n.id LIMIT $5 OFFSET $6",
        [
          actor.id,
          q.tenantId || null,
          q.kind || null,
          q.read || null,
          limit + 1,
          offset,
        ],
      );
      return {
        items: items.slice(0, limit),
        nextCursor: items.length > limit ? String(offset + limit) : null,
      };
    },
  );
  route(
    app,
    "PUT",
    "/api/v1/me/notifications/:id/read",
    {
      schema: empty,
      noIdempotency: true,
      description: "Отметить собственное событие прочитанным",
    },
    async ({ db, actor, p }) =>
      required(
        await one(
          db,
          "UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id,read_at",
          [p.id, actor.id],
        ),
      ),
  );
  route(
    app,
    "GET",
    "/api/v1/me/operations/:id",
    { description: "Получить результат своей операции" },
    async ({ db, actor, p }) => {
      const result = required(
        await one<{ scope: string; result: unknown; status_code: number }>(
          db,
          "SELECT scope,result,status_code FROM operations WHERE id=$1 AND actor_id=$2",
          [p.id, actor.id],
        ),
      );
      if (result.scope.startsWith("tenant:"))
        required(
          await one(
            db,
            "SELECT id FROM memberships WHERE user_id=$1 AND tenant_id=$2 AND status='active' AND role IN ('owner','admin')",
            [actor.id, result.scope.slice(7)],
          ),
        );
      return result;
    },
  );
  route(
    app,
    "POST",
    "/api/v1/launch/resolve",
    {
      schema: z
        .object({ payload: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/) })
        .strict(),
      noIdempotency: true,
      description: "Безопасное разрешение стартового контекста",
    },
    async ({ db, actor, b }) => {
      if (b.payload === "home") return { path: "/me/salons" };
      if (b.payload === "loyalty") return { path: "/me/loyalty" };
      const kind = b.payload.slice(0, 2),
        value = b.payload.slice(2);
      if (kind === "s_") {
        const salon = required(
          await one<Tenant>(
            db,
            "SELECT * FROM tenants WHERE public_code=$1 AND status='published'",
            [value],
          ),
        );
        return { path: `/s/${salon.public_code}` };
      }
      if (kind === "i_" || kind === "c_") return { path: `/invite/${value}` };
      if (kind === "b_" && z.uuid().safeParse(value).success) {
        const booking = required(
          await one<{ id: string; user_id: string | null; tenant_id: string }>(
            db,
            "SELECT id,user_id,tenant_id FROM bookings WHERE id=$1",
            [value],
          ),
        );
        if (booking.user_id === actor.id)
          return { path: `/me/bookings/${value}` };
        required(
          await one(
            db,
            "SELECT m.id FROM memberships m WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active' AND (m.role IN ('owner','admin') OR EXISTS(SELECT 1 FROM bookings b JOIN staff s ON s.id=b.staff_id WHERE b.id=$3 AND s.membership_id=m.id))",
            [booking.tenant_id, actor.id, value],
          ),
        );
        return { path: `/work/${booking.tenant_id}/bookings/${value}` };
      }
      if (kind === "v_" && z.uuid().safeParse(value).success) {
        required(
          await one(db, "SELECT id FROM vouchers WHERE id=$1 AND user_id=$2", [
            value,
            actor.id,
          ]),
        );
        return { path: "/me/offers" };
      }
      if (b.payload.startsWith("lw_") && z.uuid().safeParse(b.payload.slice(3)).success) {
        const offerId = b.payload.slice(3);
        required(
          await one(
            db,
            "SELECT id FROM live_window_offers WHERE id=$1 AND user_id=$2",
            [offerId, actor.id],
          ),
        );
        return { path: `/me/live-window/offers/${offerId}` };
      }
      return fail(404, "NOT_FOUND", "Ссылка недействительна");
    },
  );
}
