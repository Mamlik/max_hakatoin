import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DateTime } from "luxon";
import { route, list, page, type Context } from "./http.js";
import { one, rows, type DB } from "../db/db.js";
import { required, fail, version } from "./errors.js";
import { quote, book, command, expected } from "../contracts/schemas.js";
import type { Booking, Membership, Actor } from "./types.js";
import { tenantById } from "./salons.routes.js";
import { createQuote, confirmQuote, outcome } from "./bookings.js";
import { slots } from "./scheduling.js";

const bookingSelect =
  "SELECT b.*, c.display_name customer_name,s.name staff_name,t.name tenant_name,t.public_code FROM bookings b JOIN customers c ON c.id=b.customer_id JOIN staff s ON s.id=b.staff_id JOIN tenants t ON t.id=b.tenant_id";
export async function getBooking(
  db: DB,
  actor: Actor,
  id: string,
  tenant?: string,
  member?: Membership,
): Promise<Booking> {
  const b = required(
    await one<Booking>(
      db,
      `${bookingSelect} WHERE b.id=$1 AND ${tenant ? "b.tenant_id=$2" : "b.user_id=$2"}`,
      [id, tenant ?? actor.id],
    ),
  );
  if (
    member?.role === "master" &&
    !(await one(db, "SELECT id FROM staff WHERE id=$1 AND membership_id=$2", [
      b.staff_id,
      member.id,
    ]))
  )
    fail(404, "NOT_FOUND", "Запись недоступна");
  return b;
}
export function bookingDTO(b: Booking, member?: Membership) {
  const future = b.start_at.getTime() > Date.now();
  const allowedActions: string[] = [];
  if (b.status === "confirmed") {
    if (member?.role !== "master") {
      if (future) allowedActions.push("reschedule");
      if (future || member) allowedActions.push("cancel");
    }
    if (member && !future) allowedActions.push("complete", "no-show");
  }
  if (member?.role === "owner" && ["completed", "no_show"].includes(b.status))
    allowedActions.push("correct-outcome");
  if (member?.role === "master")
    return {
      id: b.id,
      tenantId: b.tenant_id,
      customerName: b.customer_name,
      staffId: b.staff_id,
      staffName: b.staff_name,
      serviceNameSnapshot: b.service_name_snapshot,
      startAt: b.start_at,
      endAt: b.end_at,
      status: b.status,
      version: b.version,
      allowedActions,
    };
  return {
    ...b,
    allowedActions,
    totalMinor: b.price_minor_snapshot - b.discount_minor,
  };
}
export function bookingRoutes(app: FastifyInstance) {
  route(
    app,
    "GET",
    "/api/v1/work/:t/booking-options",
    { roles: ["owner", "admin"], description: "Каталог для ручной записи" },
    async ({ db, p }) => {
      const t = await tenantById(db, p.t!);
      return {
        salon: {
          id: t.id,
          name: t.name,
          address: t.address,
          timezone: t.timezone,
          publicCode: t.public_code,
        },
        services: await rows(
          db,
          "SELECT * FROM services WHERE tenant_id=$1 AND active",
          [t.id],
        ),
        staff: await rows(
          db,
          "SELECT s.*,COALESCE(array_agg(ss.service_id) FILTER(WHERE ss.service_id IS NOT NULL),'{}') service_ids FROM staff s LEFT JOIN staff_services ss ON ss.staff_id=s.id WHERE s.tenant_id=$1 AND s.active GROUP BY s.id",
          [t.id],
        ),
        categories: [],
      };
    },
  );
  route(
    app,
    "GET",
    "/api/v1/work/:t/slots",
    {
      roles: ["owner", "admin"],
      description: "Свободные интервалы для ручной записи",
    },
    async ({ db, p, q }) =>
      list(
        await slots(
          db,
          await tenantById(db, p.t!),
          z.uuid().parse(q.serviceId),
          q.from!,
          q.to ?? q.from!,
          q.staffId,
        ),
        1500,
      ),
  );
  route(
    app,
    "GET",
    "/api/v1/me/bookings",
    { description: "Единый личный календарь и история" },
    async ({ db, actor, q }) => {
      const { limit, offset } = page(q);
      const result = await rows<Booking>(
        db,
        `${bookingSelect} WHERE b.user_id=$1 AND ($2::uuid IS NULL OR b.tenant_id=$2) AND ($3::text IS NULL OR ($3='upcoming' AND b.status='confirmed' AND b.end_at>now()) OR ($3='history' AND (b.status<>'confirmed' OR b.end_at<=now()))) AND ($4::timestamptz IS NULL OR b.start_at>=$4) AND ($5::timestamptz IS NULL OR b.start_at<$5) ORDER BY b.start_at,b.id LIMIT $6 OFFSET $7`,
        [
          actor.id,
          q.tenantId || null,
          q.state || null,
          q.from || null,
          q.to || null,
          limit + 1,
          offset,
        ],
      );
      return {
        items: result.slice(0, limit).map((b) => bookingDTO(b)),
        nextCursor: result.length > limit ? String(offset + limit) : null,
      };
    },
  );
  route(
    app,
    "GET",
    "/api/v1/work/:t/calendar",
    {
      roles: ["owner", "admin", "master"],
      description: "Календарь салона с ограничением назначений мастера",
    },
    async ({ db, p, q, member }) => {
      const from = DateTime.fromISO(
          q.from ?? DateTime.now().startOf("day").toISO()!,
        ),
        to = DateTime.fromISO(
          q.to ?? DateTime.now().plus({ days: 7 }).endOf("day").toISO()!,
        );
      if (
        !from.isValid ||
        !to.isValid ||
        to <= from ||
        to.diff(from, "days").days > 31
      )
        fail(422, "VALIDATION_ERROR", "Выберите период до 31 дня");
      const fields =
        member.role === "master"
          ? "b.id,b.tenant_id,b.staff_id,b.service_name_snapshot,b.start_at,b.end_at,b.status,b.version,c.display_name customer_name,s.name staff_name"
          : "b.*,c.display_name customer_name,s.name staff_name,t.name tenant_name";
      const result = await rows<Booking>(
        db,
        `SELECT ${fields} FROM bookings b JOIN customers c ON c.id=b.customer_id JOIN staff s ON s.id=b.staff_id JOIN tenants t ON t.id=b.tenant_id WHERE b.tenant_id=$1 AND b.start_at<$3 AND b.end_at>$2 AND ($4::uuid IS NULL OR s.id=$4) AND ($5::uuid IS NULL OR s.membership_id=$5) ORDER BY b.start_at,b.id LIMIT 1000`,
        [
          p.t,
          from.toJSDate(),
          to.toJSDate(),
          q.staffId || null,
          member.role === "master" ? member.id : null,
        ],
      );
      return list(
        result.map((b) => bookingDTO(b, member)),
        1000,
      );
    },
  );
  for (const work of [false, true]) {
    const prefix = work ? "/api/v1/work/:t" : "/api/v1/me";
    const roles = work ? (["owner", "admin", "master"] as const) : undefined;
    route(
      app,
      "GET",
      `${prefix}/bookings/:b`,
      {
        roles: roles ? [...roles] : undefined,
        description: "Карточка визита с полями доступными роли",
      },
      async ({ db, actor, member, p }) => {
        const b = await getBooking(
          db,
          actor,
          p.b!,
          work ? p.t : undefined,
          member,
        );
        const result = bookingDTO(b, work ? member : undefined);
        return {
          ...result,
          history:
            member?.role === "master"
              ? []
              : await rows(
                  db,
                  "SELECT version,reason,created_at FROM booking_revisions WHERE booking_id=$1 ORDER BY version",
                  [b.id],
                ),
          deliveries:
            member?.role === "master"
              ? []
              : await rows(
                  db,
                  "SELECT state,category,sent_at,last_error FROM deliveries WHERE booking_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 10",
                  [b.id, actor.id],
                ),
        };
      },
    );
    const manage = work
      ? (["owner", "admin"] as ("owner" | "admin")[])
      : undefined;
    route(
      app,
      "POST",
      `${work ? prefix : "/api/v1/salons/:t"}/booking-quotes`,
      {
        roles: manage,
        schema: quote,
        description: "Серверный расчёт цены и условий новой записи",
      },
      async ({ db, actor, p, b }) =>
        createQuote(db, actor, await tenantById(db, p.t!), b, work),
    );
    route(
      app,
      "POST",
      `${work ? prefix : "/api/v1/salons/:t"}/bookings`,
      {
        roles: manage,
        schema: book,
        description: "Атомарное подтверждение записи и резерв купона",
      },
      async ({ db, actor, p, b }) =>
        bookingDTO(
          await confirmQuote(db, actor, await tenantById(db, p.t!), b, work),
        ),
    );
    route(
      app,
      "POST",
      `${prefix}/bookings/:b/reschedule-quotes`,
      {
        roles: manage,
        schema: quote,
        description: "Расчёт переноса с сохранением снимка той же услуги",
      },
      async ({ db, actor, member, p, b }) => {
        const old = await getBooking(
          db,
          actor,
          p.b!,
          work ? p.t : undefined,
          member,
        );
        return createQuote(
          db,
          actor,
          await tenantById(db, old.tenant_id),
          b,
          work,
          old,
        );
      },
    );
    route(
      app,
      "GET",
      `${prefix}/bookings/:b/reschedule-options`,
      {
        roles: manage,
        description: "Актуальный каталог для сопровождения существующей записи",
      },
      async ({ db, actor, member, p }) => {
        const old = await getBooking(
          db,
          actor,
          p.b!,
          work ? p.t : undefined,
          member,
        );
        const t = await tenantById(db, old.tenant_id);
        return {
          salon: {
            id: t.id,
            name: t.name,
            address: t.address,
            timezone: t.timezone,
            publicCode: t.public_code,
          },
          services: await rows(
            db,
            "SELECT * FROM services WHERE tenant_id=$1 AND active",
            [t.id],
          ),
          staff: await rows(
            db,
            "SELECT s.id,s.name,COALESCE(array_agg(ss.service_id) FILTER(WHERE ss.service_id IS NOT NULL),'{}') service_ids FROM staff s LEFT JOIN staff_services ss ON ss.staff_id=s.id WHERE s.tenant_id=$1 AND s.active GROUP BY s.id",
            [t.id],
          ),
          categories: [],
        };
      },
    );
    route(
      app,
      "GET",
      `${prefix}/bookings/:b/reschedule-slots`,
      {
        roles: manage,
        description: "Доступные слоты для переноса, включая салон на паузе",
      },
      async ({ db, actor, member, p, q }) => {
        const old = await getBooking(
          db,
          actor,
          p.b!,
          work ? p.t : undefined,
          member,
        );
        const serviceId = z.uuid().parse(q.serviceId ?? old.service_id);
        return list(
          await slots(
            db,
            await tenantById(db, old.tenant_id),
            serviceId,
            q.from!,
            q.to ?? q.from!,
            q.staffId,
            old.id,
            serviceId === old.service_id ? old.duration_snapshot : undefined,
          ),
          1500,
        );
      },
    );
    route(
      app,
      "POST",
      `${prefix}/bookings/:b/reschedule`,
      {
        roles: manage,
        schema: book,
        description: "Атомарный перенос; при конфликте исходный визит сохранён",
      },
      async ({ db, actor, member, p, b }) => {
        const old = await getBooking(
          db,
          actor,
          p.b!,
          work ? p.t : undefined,
          member,
        );
        return bookingDTO(
          await confirmQuote(
            db,
            actor,
            await tenantById(db, old.tenant_id),
            b,
            work,
            old,
          ),
          work ? member : undefined,
        );
      },
    );
    route(
      app,
      "POST",
      `${prefix}/bookings/:b/cancel`,
      {
        roles: manage,
        schema: command,
        description: "Отмена записи и освобождение купона",
      },
      async ({ db, actor, member, p, b }) => {
        const old = await getBooking(
          db,
          actor,
          p.b!,
          work ? p.t : undefined,
          member,
        );
        version(old, b.expectedVersion);
        if (!work && old.start_at.getTime() <= Date.now())
          fail(
            409,
            "INVALID_STATE_TRANSITION",
            "Отменить запись можно только до начала",
          );
        if (work && !b.reason)
          fail(422, "VALIDATION_ERROR", "Укажите причину отмены");
        return bookingDTO(
          await outcome(db, actor, old, "cancelled", b.reason),
          work ? member : undefined,
        );
      },
    );
  }
  for (const action of ["complete", "no-show"])
    route(
      app,
      "POST",
      `/api/v1/work/:t/bookings/:b/${action}`,
      {
        roles: ["owner", "admin", "master"],
        schema: expected,
        description: "Отметить исход назначенного визита после его начала",
      },
      async ({ db, actor, member, p, b }) => {
        const old = await getBooking(db, actor, p.b!, p.t, member);
        version(old, b.expectedVersion);
        return bookingDTO(
          await outcome(
            db,
            actor,
            old,
            action === "complete" ? "completed" : "no_show",
          ),
          member,
        );
      },
    );
  route(
    app,
    "POST",
    "/api/v1/work/:t/bookings/:b/correct-outcome",
    {
      roles: ["owner"],
      schema: expected
        .extend({
          targetStatus: z.enum(["completed", "no_show", "cancelled"]),
          reason: z.string().trim().min(3).max(1000),
          restorePreviousVoucher: z.boolean().default(false),
        })
        .strict(),
      description: "Исправление исхода владельцем без повторной выдачи купонов",
    },
    async ({ db, actor, member, p, b }) => {
      const old = await getBooking(db, actor, p.b!, p.t, member);
      version(old, b.expectedVersion);
      return bookingDTO(
        await outcome(
          db,
          actor,
          old,
          b.targetStatus,
          b.reason,
          true,
          b.restorePreviousVoucher,
        ),
        member,
      );
    },
  );
}
