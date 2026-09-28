import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { z } from "zod";
import { route, audit, list } from "./http.js";
import { one, rows, type DB } from "../db/db.js";
import { AppError, fail, required, version } from "./errors.js";
import {
  command,
  liveWindowClose,
  liveWindowSettings,
  offerAccept,
  offerDecline,
  waitlistPatch,
  waitlistRequest,
} from "../contracts/schemas.js";
import type {
  Actor,
  Booking,
  LiveWindow,
  LiveWindowOffer,
  Tenant,
  WaitlistRequest,
} from "./types.js";
import { tenantById } from "./salons.routes.js";
import { slots } from "./scheduling.js";
import { createQuote, confirmQuote } from "./bookings.js";
import { advanceWindow, waitlistHash } from "./live-window.js";

const activeRequestStates = [
  "active",
  "paused",
  "paused_channel_unavailable",
  "suspended_incompatible",
];

async function requestByOwner(db: DB, actor: Actor, id: string) {
  return required(
    await one<WaitlistRequest>(
      db,
      "SELECT * FROM waitlist_requests WHERE id=$1 AND user_id=$2",
      [id, actor.id],
    ),
  );
}

async function staffIds(db: DB, requestId: string) {
  return (
    await rows<{ staff_id: string }>(
      db,
      "SELECT staff_id FROM waitlist_request_staff WHERE request_id=$1 ORDER BY staff_id",
      [requestId],
    )
  ).map((item) => item.staff_id);
}

async function requestDTO(db: DB, request: WaitlistRequest) {
  const offer = await one(
    db,
    "SELECT id,status,offered_at,expires_at,terminal_reason,version FROM live_window_offers WHERE request_id=$1 ORDER BY created_at DESC LIMIT 1",
    [request.id],
  );
  return { ...request, staff_ids: await staffIds(db, request.id), offer };
}

async function validateRequestRange(
  tenant: Tenant,
  input: {
    dateFrom: string;
    dateTo: string;
    dailyStartLocal: string;
    dailyEndLocal: string;
  },
) {
  const from = DateTime.fromISO(input.dateFrom, { zone: tenant.timezone });
  const to = DateTime.fromISO(input.dateTo, { zone: tenant.timezone });
  if (
    !from.isValid ||
    !to.isValid ||
    to < from ||
    to.diff(from, "days").days > 30 ||
    input.dailyEndLocal <= input.dailyStartLocal
  )
    fail(422, "VALIDATION_ERROR", "Проверьте диапазон дат и времени");
  if (from.startOf("day") < DateTime.now().setZone(tenant.timezone).startOf("day"))
    fail(422, "VALIDATION_ERROR", "Начальная дата уже прошла");
  return { from, to };
}

async function validateStaff(
  db: DB,
  tenantId: string,
  serviceId: string,
  ids: string[],
) {
  const unique = [...new Set(ids)].sort();
  if (!unique.length) return unique;
  const found = await rows<{ id: string }>(
    db,
    "SELECT s.id FROM staff s JOIN staff_services ss ON ss.tenant_id=s.tenant_id AND ss.staff_id=s.id WHERE s.tenant_id=$1 AND ss.service_id=$2 AND s.active AND s.id=ANY($3::uuid[]) ORDER BY s.id",
    [tenantId, serviceId, unique],
  );
  if (found.length !== unique.length)
    fail(422, "VALIDATION_ERROR", "Один из мастеров недоступен для услуги");
  return unique;
}

async function matchingFreeSlots(
  db: DB,
  tenant: Tenant,
  input: {
    serviceId: string;
    staffIds: string[];
    dateFrom: string;
    dateTo: string;
    weekdays: number[];
    dailyStartLocal: string;
    dailyEndLocal: string;
  },
  linked?: Booking,
) {
  const result = await slots(
    db,
    tenant,
    input.serviceId,
    input.dateFrom,
    input.dateTo,
    input.staffIds.length === 1 ? input.staffIds[0] : undefined,
    linked?.id,
    linked?.duration_snapshot,
  );
  return result.filter((raw) => {
    const slot = raw as { staffId: string; startAt: string; endAt: string };
    if (input.staffIds.length && !input.staffIds.includes(slot.staffId)) return false;
    const start = DateTime.fromISO(slot.startAt).setZone(tenant.timezone);
    const end = DateTime.fromISO(slot.endAt).setZone(tenant.timezone);
    return (
      input.weekdays.includes(start.weekday) &&
      start.toFormat("HH:mm") >= input.dailyStartLocal &&
      end.toFormat("HH:mm") <= input.dailyEndLocal &&
      (!linked || start.toMillis() < linked.start_at.getTime())
    );
  });
}

async function revokeOffer(db: DB, requestId: string, reason: string) {
  const offers = await rows<{ id: string; window_id: string }>(
    db,
    "UPDATE live_window_offers SET status='revoked',terminal_reason=$2,version=version+1,updated_at=now() WHERE request_id=$1 AND status IN ('pending_delivery','offered') RETURNING id,window_id",
    [requestId, reason],
  );
  for (const offer of offers) {
    await db.query(
      "UPDATE deliveries SET state='suppressed',last_error=$2 WHERE live_window_offer_id=$1 AND state IN ('scheduled','retry_wait')",
      [offer.id, reason],
    );
    await db.query(
      "UPDATE live_windows SET status='matching',version=version+1,updated_at=now() WHERE id=$1 AND status='offering'",
      [offer.window_id],
    );
    await advanceWindow(db, offer.window_id);
  }
}

function expands(
  old: WaitlistRequest & { staff_ids: string[] },
  next: {
    dateFrom: string;
    dateTo: string;
    weekdays: number[];
    dailyStartLocal: string;
    dailyEndLocal: string;
    minimumNoticeMinutes: number;
    staffIds: string[];
  },
) {
  const oldDays = new Set(old.weekdays);
  const oldStaff = new Set(old.staff_ids);
  return (
    next.dateFrom < old.date_from ||
    next.dateTo > old.date_to ||
    next.dailyStartLocal < old.daily_start_local.slice(0, 5) ||
    next.dailyEndLocal > old.daily_end_local.slice(0, 5) ||
    next.minimumNoticeMinutes < old.minimum_notice_minutes ||
    next.weekdays.some((day) => !oldDays.has(day)) ||
    (old.staff_ids.length > 0 && next.staffIds.length === 0) ||
    next.staffIds.some((id) => !oldStaff.has(id))
  );
}

export function liveWindowRoutes(app: FastifyInstance) {
  route(
    app,
    "GET",
    "/api/v1/me/waitlist-requests",
    { description: "Собственные запросы ожидания Live Window" },
    async ({ db, actor }) =>
      list(
        await Promise.all(
          (
            await rows<WaitlistRequest>(
              db,
              "SELECT * FROM waitlist_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
              [actor.id],
            )
          ).map((request) => requestDTO(db, request)),
        ),
        100,
      ),
  );

  route(
    app,
    "POST",
    "/api/v1/me/waitlist-requests",
    {
      schema: waitlistRequest,
      description: "Создать запрос ожидания после повторной проверки обычных слотов",
    },
    async ({ db, actor, b }) => {
      const tenant = await tenantById(db, b.tenantId);
      if (tenant.status !== "published")
        fail(409, "TENANT_UNAVAILABLE", "Салон сейчас не принимает записи");
      const settings = await one<{ minimum_notice_minutes: number }>(
        db,
        "SELECT minimum_notice_minutes FROM live_window_settings WHERE tenant_id=$1 AND enabled",
        [tenant.id],
      );
      if (!settings)
        fail(409, "LIVE_WINDOW_DISABLED", "Салон пока не принимает запросы ожидания");
      await validateRequestRange(tenant, b);
      const service = required(
        await one(
          db,
          "SELECT id FROM services WHERE id=$1 AND tenant_id=$2 AND active",
          [b.serviceId, tenant.id],
        ),
      );
      void service;
      const selectedStaff = await validateStaff(
        db,
        tenant.id,
        b.serviceId,
        b.staffIds,
      );
      let linked: Booking | undefined;
      if (b.linkedBookingId) {
        linked = required(
          await one<Booking>(
            db,
            "SELECT * FROM bookings WHERE id=$1 AND tenant_id=$2 AND user_id=$3",
            [b.linkedBookingId, tenant.id, actor.id],
          ),
        );
        if (
          linked.status !== "confirmed" ||
          linked.start_at <= new Date() ||
          linked.service_id !== b.serviceId ||
          b.dateTo >
            DateTime.fromJSDate(linked.start_at).setZone(tenant.timezone).toISODate()!
        )
          fail(
            409,
            "LINKED_BOOKING_UNAVAILABLE",
            "Связанную запись нельзя перенести по этим условиям",
          );
      }
      const activeCount = await one<{ count: string }>(
        db,
        "SELECT count(*)::text count FROM waitlist_requests WHERE tenant_id=$1 AND user_id=$2 AND status=ANY($3::text[])",
        [tenant.id, actor.id, activeRequestStates],
      );
      if (Number(activeCount?.count ?? 0) >= 3)
        fail(409, "WAITLIST_LIMIT", "Можно держать не более трёх активных запросов");
      const available = await matchingFreeSlots(
        db,
        tenant,
        { ...b, staffIds: selectedStaff },
        linked,
      );
      if (available.length)
        fail(409, "SLOTS_AVAILABLE", "Уже есть подходящее свободное время", {
          slots: available.slice(0, 20),
        });
      const channel = await one<{ state: string }>(
        db,
        "SELECT state FROM bot_channels WHERE user_id=$1",
        [actor.id],
      );
      const status = channel?.state === "active" ? "active" : "paused_channel_unavailable";
      const minimumNoticeMinutes = Math.max(
        b.minimumNoticeMinutes,
        settings.minimum_notice_minutes,
      );
      const eligibilityHash = waitlistHash({
        ...b,
        userId: actor.id,
        staffIds: selectedStaff,
        minimumNoticeMinutes,
      });
      const expiresAt = DateTime.fromISO(b.dateTo, { zone: tenant.timezone })
        .endOf("day")
        .toUTC()
        .toJSDate();
      const request = (await one<WaitlistRequest>(
        db,
        `INSERT INTO waitlist_requests(tenant_id,user_id,service_id,linked_booking_id,linked_booking_version,date_from,date_to,weekdays,daily_start_local,daily_end_local,minimum_notice_minutes,eligibility_hash,consent_version,consent_source,status,suspension_reason,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [
          tenant.id,
          actor.id,
          b.serviceId,
          linked?.id ?? null,
          linked?.version ?? null,
          b.dateFrom,
          b.dateTo,
          [...new Set(b.weekdays)].sort((a, c) => a - c),
          b.dailyStartLocal,
          b.dailyEndLocal,
          minimumNoticeMinutes,
          eligibilityHash,
          b.consentVersion,
          b.consentSource,
          status,
          status === "active" ? null : "MAX_CHANNEL_UNAVAILABLE",
          expiresAt,
        ],
      ))!;
      for (const id of selectedStaff)
        await db.query(
          "INSERT INTO waitlist_request_staff(tenant_id,request_id,staff_id) VALUES($1,$2,$3)",
          [tenant.id, request.id, id],
        );
      await db.query(
        `INSERT INTO preferences(user_id,tenant_id,offer_bot_enabled)
         VALUES($1,$2,true)
         ON CONFLICT(user_id,tenant_id) DO UPDATE SET offer_bot_enabled=true,version=preferences.version+CASE WHEN preferences.offer_bot_enabled THEN 0 ELSE 1 END`,
        [actor.id, tenant.id],
      );
      await audit(db, tenant.id, actor.id, "live_window.request_created", request.id, {
        linked: !!linked,
      });
      return requestDTO(db, request);
    },
  );

  route(
    app,
    "GET",
    "/api/v1/me/waitlist-requests/:id",
    { description: "Собственный запрос ожидания" },
    async ({ db, actor, p }) => requestDTO(db, await requestByOwner(db, actor, p.id!)),
  );

  route(
    app,
    "POST",
    "/api/v1/work/:t/live-window/pause",
    {
      roles: ["owner", "admin"],
      schema: command.extend({ reason: z.string().trim().min(3).max(500) }),
      description: "Поставить автоматические предложения на операционную паузу",
    },
    async ({ db, actor, p, b }) => {
      const settings = required(
        await one<{ version: number }>(
          db,
          "SELECT version FROM live_window_settings WHERE tenant_id=$1 FOR UPDATE",
          [p.t],
        ),
      );
      version(settings, b.expectedVersion);
      const active = await rows<{ id: string }>(
        db,
        "SELECT id FROM waitlist_requests WHERE tenant_id=$1 AND status='active'",
        [p.t],
      );
      for (const request of active)
        await revokeOffer(db, request.id, "TENANT_PAUSED");
      await db.query(
        "UPDATE waitlist_requests SET status='paused',suspension_reason='TENANT_PAUSED',version=version+1,updated_at=now() WHERE tenant_id=$1 AND status='active'",
        [p.t],
      );
      const result = await one(
        db,
        "UPDATE live_window_settings SET paused=true,pause_reason=$2,version=version+1,updated_at=now() WHERE tenant_id=$1 RETURNING *",
        [p.t, b.reason],
      );
      await audit(db, p.t!, actor.id, "live_window.paused", p.t!, {
        reason: b.reason,
      });
      return result;
    },
  );

  route(
    app,
    "POST",
    "/api/v1/work/:t/live-window/resume",
    {
      roles: ["owner", "admin"],
      schema: command,
      description: "Снять операционную паузу Live Window",
    },
    async ({ db, actor, p, b }) => {
      const settings = required(
        await one<{ version: number; enabled: boolean }>(
          db,
          "SELECT version,enabled FROM live_window_settings WHERE tenant_id=$1 FOR UPDATE",
          [p.t],
        ),
      );
      version(settings, b.expectedVersion);
      if (!settings.enabled)
        fail(409, "LIVE_WINDOW_DISABLED", "Сначала включите Live Window");
      const result = await one(
        db,
        "UPDATE live_window_settings SET paused=false,pause_reason=NULL,version=version+1,updated_at=now() WHERE tenant_id=$1 RETURNING *",
        [p.t],
      );
      await db.query(
        `UPDATE waitlist_requests r SET status=CASE WHEN bc.state='active' THEN 'active' ELSE 'paused_channel_unavailable' END,
           suspension_reason=CASE WHEN bc.state='active' THEN NULL ELSE 'MAX_CHANNEL_UNAVAILABLE' END,version=r.version+1,updated_at=now()
         FROM bot_channels bc WHERE r.tenant_id=$1 AND r.user_id=bc.user_id AND r.status='paused'
           AND r.suspension_reason='TENANT_PAUSED' AND r.expires_at>now()`,
        [p.t],
      );
      await audit(db, p.t!, actor.id, "live_window.resumed", p.t!, {});
      return result;
    },
  );

  route(
    app,
    "PATCH",
    "/api/v1/me/waitlist-requests/:id",
    { schema: waitlistPatch, description: "Изменить условия запроса ожидания" },
    async ({ db, actor, p, b }) => {
      const old = await requestByOwner(db, actor, p.id!);
      version(old, b.expectedVersion);
      if (!activeRequestStates.includes(old.status))
        fail(409, "INVALID_STATE_TRANSITION", "Завершённый запрос нельзя изменить");
      const tenant = await tenantById(db, old.tenant_id);
      const oldStaff = await staffIds(db, old.id);
      const next = {
        dateFrom: b.dateFrom ?? old.date_from,
        dateTo: b.dateTo ?? old.date_to,
        weekdays: b.weekdays ?? old.weekdays,
        dailyStartLocal: b.dailyStartLocal ?? old.daily_start_local.slice(0, 5),
        dailyEndLocal: b.dailyEndLocal ?? old.daily_end_local.slice(0, 5),
        minimumNoticeMinutes: b.minimumNoticeMinutes ?? old.minimum_notice_minutes,
        staffIds: await validateStaff(
          db,
          old.tenant_id,
          old.service_id,
          b.staffIds ?? oldStaff,
        ),
      };
      await validateRequestRange(tenant, next);
      const hash = waitlistHash({
        tenantId: old.tenant_id,
        userId: actor.id,
        serviceId: old.service_id,
        linkedBookingId: old.linked_booking_id,
        ...next,
      });
      await revokeOffer(db, old.id, "REQUEST_CHANGED");
      const resetPriority = expands({ ...old, staff_ids: oldStaff }, next);
      const channel = await one<{ state: string }>(db, "SELECT state FROM bot_channels WHERE user_id=$1", [actor.id]);
      const status = old.status === "paused" ? "paused" : channel?.state === "active" ? "active" : "paused_channel_unavailable";
      const updated = (await one<WaitlistRequest>(
        db,
        `UPDATE waitlist_requests SET date_from=$2,date_to=$3,weekdays=$4,daily_start_local=$5,daily_end_local=$6,minimum_notice_minutes=$7,
           eligibility_hash=$8,priority_at=CASE WHEN $9 THEN now() ELSE priority_at END,status=$10,suspension_reason=$11,version=version+1,updated_at=now()
         WHERE id=$1 RETURNING *`,
        [old.id, next.dateFrom, next.dateTo, [...new Set(next.weekdays)].sort((a,c)=>a-c), next.dailyStartLocal, next.dailyEndLocal, next.minimumNoticeMinutes, hash, resetPriority, status, status === "paused_channel_unavailable" ? "MAX_CHANNEL_UNAVAILABLE" : null],
      ))!;
      await db.query("DELETE FROM waitlist_request_staff WHERE request_id=$1", [old.id]);
      for (const id of next.staffIds)
        await db.query("INSERT INTO waitlist_request_staff(tenant_id,request_id,staff_id) VALUES($1,$2,$3)", [old.tenant_id, old.id, id]);
      await audit(db, old.tenant_id, actor.id, "live_window.request_changed", old.id, { resetPriority });
      return requestDTO(db, updated);
    },
  );

  for (const action of ["pause", "resume", "cancel"] as const)
    route(
      app,
      "POST",
      `/api/v1/me/waitlist-requests/:id/${action}`,
      { schema: command, description: `${action} запроса ожидания` },
      async ({ db, actor, p, b }) => {
        const old = await requestByOwner(db, actor, p.id!);
        version(old, b.expectedVersion);
        if (!activeRequestStates.includes(old.status))
          fail(409, "INVALID_STATE_TRANSITION", "Запрос уже завершён");
        if (action !== "resume") await revokeOffer(db, old.id, `REQUEST_${action.toUpperCase()}`);
        const channel = await one<{ state: string }>(db, "SELECT state FROM bot_channels WHERE user_id=$1", [actor.id]);
        const status = action === "cancel" ? "cancelled" : action === "pause" ? "paused" : channel?.state === "active" ? "active" : "paused_channel_unavailable";
        const updated = (await one<WaitlistRequest>(db, "UPDATE waitlist_requests SET status=$2,suspension_reason=$3,revoked_at=CASE WHEN $2='cancelled' THEN now() ELSE revoked_at END,version=version+1,updated_at=now() WHERE id=$1 RETURNING *", [old.id, status, status === "paused_channel_unavailable" ? "MAX_CHANNEL_UNAVAILABLE" : b.reason ?? null]))!;
        await audit(db, old.tenant_id, actor.id, `live_window.request_${action}`, old.id, { reason: b.reason });
        return requestDTO(db, updated);
      },
    );

  route(
    app,
    "GET",
    "/api/v1/me/live-window-offers",
    { description: "Собственные предложения Live Window" },
    async ({ db, actor }) =>
      list(
        await rows(
          db,
          `SELECT o.*,t.name tenant_name,s.name service_name,st.name staff_name,
             r.linked_booking_id,r.status request_status
           FROM live_window_offers o
           JOIN waitlist_requests r ON r.id=o.request_id AND r.tenant_id=o.tenant_id
           JOIN tenants t ON t.id=o.tenant_id
           JOIN services s ON s.id=o.service_id AND s.tenant_id=o.tenant_id
           JOIN staff st ON st.id=o.staff_id AND st.tenant_id=o.tenant_id
          WHERE o.user_id=$1 ORDER BY o.created_at DESC LIMIT 100`,
          [actor.id],
        ),
        100,
      ),
  );

  route(
    app,
    "GET",
    "/api/v1/me/live-window-offers/:id",
    { description: "Собственное предложение Live Window" },
    async ({ db, actor, p }) =>
      required(
        await one(
          db,
          `SELECT o.*,w.start_at,w.end_at,w.staff_id,w.service_id,t.name tenant_name,t.timezone,s.name service_name,st.name staff_name,
             r.linked_booking_id,r.status request_status
           FROM live_window_offers o JOIN live_windows w ON w.id=o.window_id AND w.tenant_id=o.tenant_id
           JOIN waitlist_requests r ON r.id=o.request_id AND r.tenant_id=o.tenant_id
           JOIN tenants t ON t.id=o.tenant_id JOIN services s ON s.id=w.service_id JOIN staff st ON st.id=w.staff_id
          WHERE o.id=$1 AND o.user_id=$2`,
          [p.id, actor.id],
        ),
      ),
  );

  route(
    app,
    "POST",
    "/api/v1/me/live-window-offers/:id/accept",
    { schema: offerAccept, description: "Атомарно принять предложение Live Window" },
    async ({ db, actor, p, b }) => {
      const offer = required(
        await one<LiveWindowOffer>(db, "SELECT * FROM live_window_offers WHERE id=$1 AND user_id=$2 FOR UPDATE", [p.id, actor.id]),
      );
      version(offer, b.expectedVersion);
      const request = required(await one<WaitlistRequest>(db, "SELECT * FROM waitlist_requests WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [offer.request_id, offer.tenant_id]));
      const window = required(await one<LiveWindow>(db, "SELECT * FROM live_windows WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [offer.window_id, offer.tenant_id]));
      if (offer.status !== "offered" || !offer.expires_at || offer.expires_at <= new Date()) {
        if (offer.status === "offered") {
          await db.query("UPDATE live_window_offers SET status='expired',terminal_reason='ttl',version=version+1,updated_at=now() WHERE id=$1", [offer.id]);
          await db.query("UPDATE live_windows SET status='matching',version=version+1,updated_at=now() WHERE id=$1", [window.id]);
          await advanceWindow(db, window.id);
        }
        return { status: "unavailable", reason: "OFFER_NOT_AVAILABLE" };
      }
      if (request.status !== "active" || request.version !== offer.request_version || request.eligibility_hash !== offer.eligibility_hash || window.status !== "offering")
        fail(409, "OFFER_NOT_AVAILABLE", "Предложение больше недоступно");
      const tenant = await tenantById(db, offer.tenant_id);
      let linked: Booking | undefined;
      if (request.linked_booking_id) {
        linked = required(await one<Booking>(db, "SELECT * FROM bookings WHERE id=$1 AND tenant_id=$2 AND user_id=$3 FOR UPDATE", [request.linked_booking_id, offer.tenant_id, actor.id]));
        if (
          linked.status !== "confirmed" ||
          linked.version !== request.linked_booking_version
        ) {
          await db.query(
            "UPDATE live_window_offers SET status='revoked',terminal_reason='LINKED_BOOKING_CHANGED',version=version+1,updated_at=now() WHERE id=$1",
            [offer.id],
          );
          await db.query(
            "UPDATE waitlist_requests SET status='suspended_incompatible',suspension_reason='LINKED_BOOKING_CHANGED',version=version+1,updated_at=now() WHERE id=$1",
            [request.id],
          );
          await db.query(
            "UPDATE live_windows SET status='matching',version=version+1,updated_at=now() WHERE id=$1 AND status='offering'",
            [window.id],
          );
          await audit(
            db,
            offer.tenant_id,
            actor.id,
            "live_window.offer_revoked",
            offer.id,
            { reason: "LINKED_BOOKING_CHANGED" },
          );
          await advanceWindow(db, window.id);
          return {
            status: "unavailable",
            reason: "LINKED_BOOKING_CHANGED",
          };
        }
      }
      try {
        const quote = await createQuote(db, actor, tenant, {
          serviceId: request.service_id,
          staffId: window.staff_id,
          startAt: window.start_at.toISOString(),
          ...(linked ? { expectedVersion: linked.version } : {}),
        }, false, linked);
        const booking = await confirmQuote(db, actor, tenant, {
          quoteId: quote.id,
          expectedVersion: linked?.version,
          confirmOverlap: b.confirmOverlap,
          overlapChallengeToken: b.overlapChallengeToken,
          removeVoucher: b.removeVoucher,
        }, false, linked, "live_window");
        await db.query("UPDATE live_window_offers SET status='booked',booking_id=$2,version=version+1,updated_at=now() WHERE id=$1", [offer.id, booking.id]);
        await db.query("UPDATE waitlist_requests SET status='fulfilled',version=version+1,updated_at=now() WHERE id=$1", [request.id]);
        await db.query("UPDATE live_windows SET status='filled',filled_booking_id=$2,version=version+1,updated_at=now() WHERE id=$1", [window.id, booking.id]);
        await audit(db, offer.tenant_id, actor.id, "live_window.offer_booked", offer.id, { bookingId: booking.id, linked: !!linked });
        return { status: "booked", booking };
      } catch (error) {
        if (error instanceof AppError && error.code === "SLOT_UNAVAILABLE") {
          await db.query("UPDATE live_window_offers SET status='lost',terminal_reason='slot_taken',version=version+1,updated_at=now() WHERE id=$1", [offer.id]);
          await db.query("UPDATE live_windows SET status='closed',close_reason='occupied_external',version=version+1,updated_at=now() WHERE id=$1", [window.id]);
          await audit(db, offer.tenant_id, actor.id, "live_window.offer_lost", offer.id, { reason: "slot_taken" });
          return { status: "lost", reason: "SLOT_UNAVAILABLE" };
        }
        throw error;
      }
    },
  );

  route(
    app,
    "POST",
    "/api/v1/me/live-window-offers/:id/decline",
    { schema: offerDecline, description: "Отклонить предложение и продолжить FIFO" },
    async ({ db, actor, p, b }) => {
      const offer = required(await one<LiveWindowOffer>(db, "SELECT * FROM live_window_offers WHERE id=$1 AND user_id=$2 FOR UPDATE", [p.id, actor.id]));
      version(offer, b.expectedVersion);
      if (offer.status !== "offered") fail(409, "OFFER_NOT_AVAILABLE", "Предложение уже закрыто");
      await db.query("UPDATE live_window_offers SET status='declined',terminal_reason=$2,version=version+1,updated_at=now() WHERE id=$1", [offer.id, b.stopRequest ? "stop_request" : "declined"]);
      if (b.stopRequest) await db.query("UPDATE waitlist_requests SET status='cancelled',revoked_at=now(),version=version+1,updated_at=now() WHERE id=$1 AND user_id=$2", [offer.request_id, actor.id]);
      await db.query("UPDATE live_windows SET status='matching',version=version+1,updated_at=now() WHERE id=$1 AND status='offering'", [offer.window_id]);
      await audit(db, offer.tenant_id, actor.id, "live_window.offer_declined", offer.id, { stopRequest: b.stopRequest });
      await advanceWindow(db, offer.window_id);
      return { status: "declined" };
    },
  );

  route(
    app,
    "GET",
    "/api/v1/work/:t/live-window/settings",
    { roles: ["owner", "admin"], description: "Настройки Live Window салона" },
    async ({ db, p }) =>
      (await one(db, "SELECT * FROM live_window_settings WHERE tenant_id=$1", [p.t])) ?? {
        tenantId: p.t, enabled: false, paused: false, offerTtlMinutes: 10,
        minimumNoticeMinutes: 60, quietStart: "09:00", quietEnd: "21:00", version: 0,
      },
  );

  route(
    app,
    "PATCH",
    "/api/v1/work/:t/live-window/settings",
    { roles: ["owner"], schema: liveWindowSettings, description: "Включить и настроить Live Window" },
    async ({ db, actor, p, b }) => {
      const old = await one<{ version: number }>(db, "SELECT version FROM live_window_settings WHERE tenant_id=$1 FOR UPDATE", [p.t]);
      if ((old?.version ?? 0) !== b.expectedVersion) fail(409, "STALE_VERSION", "Настройки изменились");
      const result = await one(db, `INSERT INTO live_window_settings(tenant_id,enabled,paused,pause_reason,offer_ttl_minutes,minimum_notice_minutes,quiet_start,quiet_end)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(tenant_id) DO UPDATE SET enabled=$2,paused=$3,pause_reason=$4,offer_ttl_minutes=$5,minimum_notice_minutes=$6,quiet_start=$7,quiet_end=$8,version=live_window_settings.version+1,updated_at=now() RETURNING *`,
        [p.t,b.enabled,b.paused,b.pauseReason ?? null,b.offerTtlMinutes,b.minimumNoticeMinutes,b.quietStart,b.quietEnd]);
      if (!b.enabled || b.paused) {
        const active = await rows<{ id: string }>(db, "SELECT id FROM waitlist_requests WHERE tenant_id=$1 AND status='active'", [p.t]);
        for (const request of active) await revokeOffer(db, request.id, b.enabled ? "TENANT_PAUSED" : "FEATURE_DISABLED");
        await db.query("UPDATE waitlist_requests SET status='paused',suspension_reason=$2,version=version+1,updated_at=now() WHERE tenant_id=$1 AND status='active'", [p.t,b.enabled ? "TENANT_PAUSED" : "FEATURE_DISABLED"]);
      } else {
        await db.query(
          `UPDATE waitlist_requests r SET status=CASE WHEN bc.state='active' THEN 'active' ELSE 'paused_channel_unavailable' END,
             suspension_reason=CASE WHEN bc.state='active' THEN NULL ELSE 'MAX_CHANNEL_UNAVAILABLE' END,version=r.version+1,updated_at=now()
           FROM bot_channels bc WHERE r.tenant_id=$1 AND r.user_id=bc.user_id AND r.status='paused'
             AND r.suspension_reason IN ('TENANT_PAUSED','FEATURE_DISABLED') AND r.expires_at>now()`,
          [p.t],
        );
      }
      await audit(db, p.t!, actor.id, "live_window.settings_changed", p.t!, { enabled: b.enabled, paused: b.paused });
      return result;
    },
  );

  route(
    app,
    "GET",
    "/api/v1/work/:t/live-window/windows",
    { roles: ["owner", "admin"], description: "Окна и обезличенная цепочка предложений" },
    async ({ db, p }) => list(await rows(db, `SELECT w.*,s.name service_name,st.name staff_name,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('sequence',o.sequence,'status',o.status,'createdAt',o.created_at,'terminalReason',o.terminal_reason) ORDER BY o.sequence) FROM live_window_offers o WHERE o.window_id=w.id),'[]') offers
      FROM live_windows w JOIN services s ON s.id=w.service_id JOIN staff st ON st.id=w.staff_id WHERE w.tenant_id=$1 ORDER BY w.created_at DESC LIMIT 100`, [p.t]), 100),
  );

  route(
    app,
    "GET",
    "/api/v1/work/:t/live-window/windows/:id",
    {
      roles: ["owner", "admin"],
      description: "Одно Live Window и обезличенная цепочка предложений",
    },
    async ({ db, p }) =>
      required(
        await one(
          db,
          `SELECT w.*,s.name service_name,st.name staff_name,
             COALESCE((SELECT jsonb_agg(jsonb_build_object('sequence',o.sequence,'status',o.status,'createdAt',o.created_at,'terminalReason',o.terminal_reason) ORDER BY o.sequence) FROM live_window_offers o WHERE o.window_id=w.id),'[]') offers
           FROM live_windows w
           JOIN services s ON s.id=w.service_id AND s.tenant_id=w.tenant_id
           JOIN staff st ON st.id=w.staff_id AND st.tenant_id=w.tenant_id
          WHERE w.id=$1 AND w.tenant_id=$2`,
          [p.id, p.t],
        ),
      ),
  );

  route(
    app,
    "POST",
    "/api/v1/work/:t/live-window/windows/:id/close",
    { roles: ["owner", "admin"], schema: liveWindowClose, description: "Закрыть конкретное Live Window" },
    async ({ db, actor, p, b }) => {
      const window = required(await one<LiveWindow>(db, "SELECT * FROM live_windows WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [p.id,p.t]));
      version(window,b.expectedVersion);
      const result = await one(db, "UPDATE live_windows SET status='closed',close_reason=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *", [window.id,b.reason]);
      const offers = await rows<{ id: string }>(db, "UPDATE live_window_offers SET status='revoked',terminal_reason='WINDOW_CLOSED',version=version+1,updated_at=now() WHERE window_id=$1 AND status IN ('pending_delivery','offered') RETURNING id", [window.id]);
      for (const offer of offers) await db.query("UPDATE deliveries SET state='suppressed',last_error='WINDOW_CLOSED' WHERE live_window_offer_id=$1 AND state IN ('scheduled','retry_wait')", [offer.id]);
      await audit(db,p.t!,actor.id,"live_window.window_closed",window.id,{reason:b.reason});
      return result;
    },
  );

  route(
    app,
    "GET",
    "/api/v1/work/:t/live-window/summary",
    { roles: ["owner", "admin"], description: "Агрегированные метрики Live Window" },
    async ({ db, p }) => one(db, `SELECT
      (SELECT count(*)::int FROM waitlist_requests WHERE tenant_id=$1 AND status='active') active_requests,
      (SELECT count(*)::int FROM live_windows WHERE tenant_id=$1 AND status IN ('detected','matching','offering')) active_windows,
      (SELECT count(*)::int FROM live_windows WHERE tenant_id=$1 AND status='filled') filled_windows,
      (SELECT count(*)::int FROM live_window_offers WHERE tenant_id=$1 AND status='lost') lost_offers,
      (SELECT count(*)::int FROM domain_outbox WHERE tenant_id=$1 AND state='dead') dead_events`, [p.t]),
  );
}
