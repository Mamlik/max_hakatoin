import { DateTime } from "luxon";
import { canonical, hash } from "./auth.js";
import { checkSlot } from "./scheduling.js";
import { notify } from "./notifications.js";
import { one, pool, rows, tx, type DB } from "../db/db.js";
import type {
  Booking,
  LiveWindow,
  Service,
  Staff,
  Tenant,
  WaitlistRequest,
} from "./types.js";

export interface WaitlistFingerprint {
  tenantId: string;
  userId: string;
  serviceId: string;
  linkedBookingId?: string | null;
  dateFrom: string;
  dateTo: string;
  weekdays: number[];
  dailyStartLocal: string;
  dailyEndLocal: string;
  minimumNoticeMinutes: number;
  staffIds: string[];
}

export function waitlistHash(input: WaitlistFingerprint) {
  return hash(
    canonical({
      tenantId: input.tenantId,
      userId: input.userId,
      serviceId: input.serviceId,
      linkedBookingId: input.linkedBookingId ?? null,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      weekdays: [...new Set(input.weekdays)].sort((a, b) => a - b),
      dailyStartLocal: input.dailyStartLocal,
      dailyEndLocal: input.dailyEndLocal,
      minimumNoticeMinutes: input.minimumNoticeMinutes,
      staffIds: [...new Set(input.staffIds)].sort(),
    }),
  );
}

export async function emitSlotReleased(
  db: DB,
  bookingBefore: Booking,
  postTransitionVersion: number,
  cause: "cancelled" | "rescheduled" | "live_window",
  cascade = cause !== "live_window",
) {
  const eventKey = `booking.slot_released:${bookingBefore.id}:${postTransitionVersion}`;
  await db.query(
    "INSERT INTO domain_outbox(tenant_id,event_key,event_type,payload) VALUES($1,$2,'booking.slot_released',$3) ON CONFLICT(event_key) DO NOTHING",
    [
      bookingBefore.tenant_id,
      eventKey,
      JSON.stringify({
        bookingId: bookingBefore.id,
        bookingVersion: postTransitionVersion,
        staffId: bookingBefore.staff_id,
        serviceId: bookingBefore.service_id,
        startAt: bookingBefore.start_at,
        endAt: bookingBefore.end_at,
        durationSnapshot: bookingBefore.duration_snapshot,
        timezoneSnapshot: bookingBefore.timezone_snapshot,
        cause,
        cascade,
      }),
    ],
  );
}

type Settings = {
  tenant_id: string;
  enabled: boolean;
  paused: boolean;
  offer_ttl_minutes: number;
  minimum_notice_minutes: number;
  quiet_start: string;
  quiet_end: string;
  version: number;
};

async function effectiveSettings(db: DB, tenantId: string) {
  const settings = await one<Settings>(
    db,
    "SELECT * FROM live_window_settings WHERE tenant_id=$1",
    [tenantId],
  );
  const platform = await rows<{ key: string; enabled: boolean }>(
    db,
    "SELECT key,COALESCE((value->>'enabled')::boolean,false) enabled FROM system_state WHERE key IN ('live_window_allowlist','live_window_kill_switch')",
  );
  const map = new Map(platform.map((item) => [item.key, item.enabled]));
  return {
    settings,
    allowed:
      map.get("live_window_allowlist") === true &&
      map.get("live_window_kill_switch") !== true &&
      settings?.enabled === true &&
      settings.paused !== true,
  };
}

function nextQuietDelivery(
  tenant: Tenant,
  settings: Settings,
  now = DateTime.now(),
) {
  const local = now.setZone(tenant.timezone);
  const [startHour, startMinute] = settings.quiet_start
    .slice(0, 5)
    .split(":")
    .map(Number);
  const [endHour, endMinute] = settings.quiet_end
    .slice(0, 5)
    .split(":")
    .map(Number);
  const start = local.set({
    hour: startHour,
    minute: startMinute,
    second: 0,
    millisecond: 0,
  });
  const end = local.set({
    hour: endHour,
    minute: endMinute,
    second: 0,
    millisecond: 0,
  });
  if (local >= start && local < end) return now.toJSDate();
  return (local < start ? start : start.plus({ days: 1 })).toUTC().toJSDate();
}

async function compatible(
  db: DB,
  request: WaitlistRequest,
  window: LiveWindow,
  tenant: Tenant,
  service: Service,
  staff: Staff,
) {
  const start = DateTime.fromJSDate(window.start_at).setZone(tenant.timezone);
  const localDate = start.toISODate()!;
  if (localDate < request.date_from || localDate > request.date_to) return false;
  if (!request.weekdays.includes(start.weekday)) return false;
  if (start.toFormat("HH:mm") < request.daily_start_local.slice(0, 5))
    return false;
  let duration = service.duration_min;
  let linked: Booking | undefined;
  if (request.linked_booking_id) {
    linked = await one<Booking>(
      db,
      "SELECT * FROM bookings WHERE id=$1 AND tenant_id=$2 AND user_id=$3",
      [request.linked_booking_id, request.tenant_id, request.user_id],
    );
    if (
      !linked ||
      linked.status !== "confirmed" ||
      linked.version !== request.linked_booking_version ||
      window.start_at >= linked.start_at
    )
      return false;
    duration = linked.duration_snapshot;
  }
  const visitEnd = start.plus({ minutes: duration });
  if (visitEnd.toFormat("HH:mm") > request.daily_end_local.slice(0, 5))
    return false;
  if (visitEnd.toMillis() > window.end_at.getTime()) return false;
  if (
    window.start_at.getTime() - Date.now() <
    request.minimum_notice_minutes * 60_000
  )
    return false;
  const overlap = await one(
    db,
    "SELECT id FROM bookings WHERE user_id=$1 AND status='confirmed' AND start_at<$3 AND end_at>$2 AND ($4::uuid IS NULL OR id<>$4) LIMIT 1",
    [request.user_id, window.start_at, visitEnd.toJSDate(), linked?.id ?? null],
  );
  if (overlap) return false;
  try {
    await checkSlot(
      db,
      tenant,
      service,
      staff,
      window.start_at.toISOString(),
      duration,
      linked?.id,
    );
  } catch {
    return false;
  }
  return true;
}

export async function advanceWindow(db: DB, windowId: string) {
  const window = await one<LiveWindow>(
    db,
    "SELECT * FROM live_windows WHERE id=$1 FOR UPDATE",
    [windowId],
  );
  if (!window || !["detected", "matching"].includes(window.status)) return;
  const { settings, allowed } = await effectiveSettings(db, window.tenant_id);
  if (!settings || !allowed) {
    await db.query(
      "UPDATE live_windows SET status='closed',close_reason='feature_disabled',version=version+1,updated_at=now() WHERE id=$1",
      [window.id],
    );
    return;
  }
  const tenant = (await one<Tenant>(db, "SELECT * FROM tenants WHERE id=$1", [
    window.tenant_id,
  ]))!;
  const service = await one<Service>(
    db,
    "SELECT * FROM services WHERE id=$1 AND tenant_id=$2 AND active",
    [window.service_id, window.tenant_id],
  );
  const staff = await one<Staff>(
    db,
    "SELECT * FROM staff WHERE id=$1 AND tenant_id=$2 AND active AND EXISTS(SELECT 1 FROM staff_services ss WHERE ss.tenant_id=$2 AND ss.staff_id=$1 AND ss.service_id=$3)",
    [window.staff_id, window.tenant_id, window.service_id],
  );
  if (!service || !staff || window.start_at <= new Date()) {
    await db.query(
      "UPDATE live_windows SET status='exhausted',close_reason='window_unavailable',version=version+1,updated_at=now() WHERE id=$1",
      [window.id],
    );
    return;
  }
  await db.query(
    "UPDATE live_windows SET status='matching',version=version+1,updated_at=now() WHERE id=$1",
    [window.id],
  );
  await db.query(
    `INSERT INTO audit_log(tenant_id,actor_id,action,object_id,details)
     SELECT r.tenant_id,r.user_id,'live_window.candidate_skipped',r.id,
       jsonb_build_object(
         'windowId',$3::text,
         'reason',CASE
           WHEN EXISTS(SELECT 1 FROM live_window_offers active WHERE active.user_id=r.user_id AND active.status IN ('pending_delivery','offered','accepted')) THEN 'ACTIVE_OFFER'
           WHEN (SELECT count(*) FROM live_window_offers recent WHERE recent.request_id=r.id AND recent.created_at>now()-interval '24 hours')>=3 THEN 'REQUEST_DAILY_LIMIT'
           ELSE 'USER_COOLDOWN'
         END
       )
     FROM waitlist_requests r
     WHERE r.tenant_id=$1 AND r.service_id=$2 AND r.status='active' AND r.expires_at>now()
       AND (
         EXISTS(SELECT 1 FROM live_window_offers active WHERE active.user_id=r.user_id AND active.status IN ('pending_delivery','offered','accepted')) OR
         (SELECT count(*) FROM live_window_offers recent WHERE recent.request_id=r.id AND recent.created_at>now()-interval '24 hours')>=3 OR
         EXISTS(SELECT 1 FROM live_window_offers recent_user WHERE recent_user.user_id=r.user_id AND recent_user.created_at>now()-interval '30 minutes')
       )
       AND NOT EXISTS(
         SELECT 1 FROM audit_log a
         WHERE a.action='live_window.candidate_skipped' AND a.object_id=r.id
           AND a.details->>'windowId'=$3::text
       )`,
    [window.tenant_id, window.service_id, window.id],
  );
  const candidates = await rows<WaitlistRequest & { staff_ids: string[] }>(
    db,
    `SELECT r.*,COALESCE(array_agg(rs.staff_id) FILTER(WHERE rs.staff_id IS NOT NULL),'{}') staff_ids
       FROM waitlist_requests r
       JOIN bot_channels bc ON bc.user_id=r.user_id AND bc.state='active'
       LEFT JOIN waitlist_request_staff rs ON rs.request_id=r.id AND rs.tenant_id=r.tenant_id
      WHERE r.tenant_id=$1 AND r.service_id=$2 AND r.status='active' AND r.expires_at>now()
        AND NOT EXISTS(SELECT 1 FROM live_window_offers old WHERE old.window_id=$3 AND old.request_id=r.id)
        AND NOT EXISTS(SELECT 1 FROM live_window_offers active WHERE active.user_id=r.user_id AND active.status IN ('pending_delivery','offered','accepted'))
        AND (SELECT count(*) FROM live_window_offers recent WHERE recent.request_id=r.id AND recent.created_at>now()-interval '24 hours')<3
        AND NOT EXISTS(SELECT 1 FROM live_window_offers recent_user WHERE recent_user.user_id=r.user_id AND recent_user.created_at>now()-interval '30 minutes')
      GROUP BY r.id ORDER BY r.priority_at,r.id LIMIT 100`,
    [window.tenant_id, window.service_id, window.id],
  );
  for (const request of candidates) {
    if (request.staff_ids.length && !request.staff_ids.includes(window.staff_id))
      continue;
    if (!(await compatible(db, request, window, tenant, service, staff)))
      continue;
    const sequence =
      Number(
        (
          await one<{ n: string }>(
            db,
            "SELECT count(*)::text n FROM live_window_offers WHERE window_id=$1",
            [window.id],
          )
        )?.n ?? "0",
      ) + 1;
    const linkedDuration = request.linked_booking_id
      ? (
          await one<{ duration_snapshot: number }>(
            db,
            "SELECT duration_snapshot FROM bookings WHERE id=$1 AND tenant_id=$2 AND user_id=$3",
            [request.linked_booking_id, request.tenant_id, request.user_id],
          )
        )?.duration_snapshot
      : undefined;
    const offeredDuration = linkedDuration ?? service.duration_min;
    const visitEnd = DateTime.fromJSDate(window.start_at)
      .plus({ minutes: offeredDuration })
      .toJSDate();
    const offer = await one<{ id: string }>(
      db,
      `INSERT INTO live_window_offers(tenant_id,window_id,request_id,user_id,request_version,eligibility_hash,
         service_id,staff_id,visit_start_at,visit_end_at,price_minor_snapshot,duration_snapshot,timezone_snapshot,sequence)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        window.tenant_id,
        window.id,
        request.id,
        request.user_id,
        request.version,
        request.eligibility_hash,
        service.id,
        staff.id,
        window.start_at,
        visitEnd,
        service.price_minor,
        offeredDuration,
        tenant.timezone,
        sequence,
      ],
    );
    await db.query(
      "UPDATE live_windows SET status='offering',version=version+1,updated_at=now() WHERE id=$1",
      [window.id],
    );
    const dueAt = nextQuietDelivery(tenant, settings);
    if (
      dueAt.getTime() + settings.offer_ttl_minutes * 60_000 >=
      window.start_at.getTime()
    ) {
      await db.query(
        "UPDATE live_window_offers SET status='delivery_failed',terminal_reason='quiet_hours_or_notice',version=version+1,updated_at=now() WHERE id=$1",
        [offer!.id],
      );
      await db.query(
        "UPDATE live_windows SET status='matching',version=version+1,updated_at=now() WHERE id=$1",
        [window.id],
      );
      continue;
    }
    await notify(
      db,
      request.user_id,
      window.tenant_id,
      "live_window.offer",
      offer!.id,
      "Освободилось подходящее время",
      `${tenant.name}: ${service.name}, ${startLabel(window.start_at, tenant.timezone)}. Слот не зарезервирован и доступен другим клиентам.`,
      {
        category: "live_window",
        dueAt,
        notAfter: window.start_at,
        liveWindowOfferId: offer!.id,
      },
    );
    return;
  }
  await db.query(
    "UPDATE live_windows SET status='exhausted',close_reason='no_eligible_candidates',version=version+1,updated_at=now() WHERE id=$1",
    [window.id],
  );
}

function startLabel(value: Date, timezone: string) {
  return DateTime.fromJSDate(value)
    .setZone(timezone)
    .setLocale("ru")
    .toFormat("dd LLL, HH:mm");
}

type DomainEvent = {
    id: string;
    tenant_id: string;
    event_key: string;
    payload: Record<string, unknown>;
    fence: number;
    attempts: number;
  };

async function processOutboxEvent(db: DB, event: DomainEvent) {
  const payload = event.payload;
  if (payload.cascade !== false) {
    const window = await one<{ id: string }>(
      db,
      `INSERT INTO live_windows(tenant_id,staff_id,service_id,source_event_key,source_booking_id,source_booking_version,start_at,end_at,duration_snapshot,timezone_snapshot)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(source_event_key) DO UPDATE SET source_event_key=EXCLUDED.source_event_key RETURNING id`,
      [
        event.tenant_id,
        payload.staffId,
        payload.serviceId,
        event.event_key,
        payload.bookingId,
        payload.bookingVersion,
        payload.startAt,
        payload.endAt,
        payload.durationSnapshot,
        payload.timezoneSnapshot,
      ],
    );
    await advanceWindow(db, window!.id);
  }
  await db.query(
    "UPDATE domain_outbox SET state='processed',processed_at=now(),lease_until=NULL,last_error=NULL WHERE id=$1 AND fence=$2",
    [event.id, event.fence],
  );
}

export async function runLiveWindowCycle() {
  const incompatibleRequests = await rows<{
    id: string;
    reason: string;
  }>(
    pool,
    `SELECT r.id,
       CASE
         WHEN s.id IS NULL OR NOT s.active THEN 'SERVICE_INACTIVE'
         WHEN r.linked_booking_id IS NOT NULL AND (b.id IS NULL OR b.status<>'confirmed' OR b.version<>r.linked_booking_version) THEN 'LINKED_BOOKING_CHANGED'
         ELSE 'STAFF_INACTIVE'
       END reason
     FROM waitlist_requests r
     LEFT JOIN services s ON s.id=r.service_id AND s.tenant_id=r.tenant_id
     LEFT JOIN bookings b ON b.id=r.linked_booking_id AND b.tenant_id=r.tenant_id AND b.user_id=r.user_id
     WHERE r.status='active' AND (
       s.id IS NULL OR NOT s.active OR
       (r.linked_booking_id IS NOT NULL AND (b.id IS NULL OR b.status<>'confirmed' OR b.version<>r.linked_booking_version)) OR
       (EXISTS(SELECT 1 FROM waitlist_request_staff selected WHERE selected.request_id=r.id)
        AND NOT EXISTS(
          SELECT 1 FROM waitlist_request_staff selected
          JOIN staff st ON st.id=selected.staff_id AND st.tenant_id=selected.tenant_id AND st.active
          JOIN staff_services ss ON ss.tenant_id=st.tenant_id AND ss.staff_id=st.id AND ss.service_id=r.service_id
          WHERE selected.request_id=r.id
        ))
     )
     LIMIT 100`,
  );
  for (const request of incompatibleRequests)
    await tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(724992)");
      const offers = await rows<{ id: string; window_id: string }>(
        db,
        "UPDATE live_window_offers SET status='revoked',terminal_reason=$2,version=version+1,updated_at=now() WHERE request_id=$1 AND status IN ('pending_delivery','offered') RETURNING id,window_id",
        [request.id, request.reason],
      );
      await db.query(
        "UPDATE waitlist_requests SET status='suspended_incompatible',suspension_reason=$2,version=version+1,updated_at=now() WHERE id=$1 AND status='active'",
        [request.id, request.reason],
      );
      for (const offer of offers) {
        await db.query(
          "UPDATE deliveries SET state='suppressed',last_error=$2 WHERE live_window_offer_id=$1 AND state IN ('scheduled','retry_wait')",
          [offer.id, request.reason],
        );
        await db.query(
          "UPDATE live_windows SET status='matching',version=version+1,updated_at=now() WHERE id=$1 AND status='offering'",
          [offer.window_id],
        );
        await advanceWindow(db, offer.window_id);
      }
    });
  const platform = await rows<{ key: string; enabled: boolean }>(
    pool,
    "SELECT key,COALESCE((value->>'enabled')::boolean,false) enabled FROM system_state WHERE key IN ('live_window_allowlist','live_window_kill_switch')",
  );
  const platformState = new Map(platform.map((item) => [item.key, item.enabled]));
  if (
    platformState.get("live_window_allowlist") !== true ||
    platformState.get("live_window_kill_switch") === true
  ) {
    await tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(724992)");
      const offers = await rows<{ id: string; window_id: string }>(
        db,
        "UPDATE live_window_offers SET status='revoked',terminal_reason='PLATFORM_DISABLED',version=version+1,updated_at=now() WHERE status IN ('pending_delivery','offered') RETURNING id,window_id",
      );
      for (const offer of offers)
        await db.query(
          "UPDATE deliveries SET state='suppressed',last_error='PLATFORM_DISABLED' WHERE live_window_offer_id=$1 AND state IN ('scheduled','retry_wait')",
          [offer.id],
        );
      await db.query(
        "UPDATE waitlist_requests SET status='paused',suspension_reason='PLATFORM_DISABLED',version=version+1,updated_at=now() WHERE status='active'",
      );
      await db.query(
        "UPDATE live_windows SET status='closed',close_reason='platform_disabled',version=version+1,updated_at=now() WHERE status IN ('detected','matching','offering')",
      );
    });
  }
  const expiredRequests = await rows<{ id: string }>(
    pool,
    "SELECT id FROM waitlist_requests WHERE status=ANY($1::text[]) AND expires_at<=now() LIMIT 100",
    [activeRequestStatuses],
  );
  for (const request of expiredRequests)
    await tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(724992)");
      const offers = await rows<{ id: string; window_id: string }>(
        db,
        "UPDATE live_window_offers SET status='revoked',terminal_reason='REQUEST_EXPIRED',version=version+1,updated_at=now() WHERE request_id=$1 AND status IN ('pending_delivery','offered') RETURNING id,window_id",
        [request.id],
      );
      await db.query(
        "UPDATE waitlist_requests SET status='expired',suspension_reason=NULL,version=version+1,updated_at=now() WHERE id=$1 AND status=ANY($2::text[])",
        [request.id, activeRequestStatuses],
      );
      for (const offer of offers) {
        await db.query(
          "UPDATE deliveries SET state='suppressed',last_error='REQUEST_EXPIRED' WHERE live_window_offer_id=$1 AND state IN ('scheduled','retry_wait')",
          [offer.id],
        );
        await db.query(
          "UPDATE live_windows SET status='matching',version=version+1,updated_at=now() WHERE id=$1 AND status='offering'",
          [offer.window_id],
        );
        await advanceWindow(db, offer.window_id);
      }
    });
  const expiredWindows = await rows<{ window_id: string }>(
    pool,
    "SELECT DISTINCT window_id FROM live_window_offers WHERE status='offered' AND expires_at<=now() LIMIT 100",
  );
  for (const item of expiredWindows)
    await tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(724992)");
      const updated = await one<{ window_id: string }>(
        db,
        "UPDATE live_window_offers SET status='expired',terminal_reason='ttl',version=version+1,updated_at=now() WHERE window_id=$1 AND status='offered' AND expires_at<=now() RETURNING window_id",
        [item.window_id],
      );
      if (updated) {
        await db.query(
          "UPDATE live_windows SET status='matching',version=version+1,updated_at=now() WHERE id=$1 AND status='offering'",
          [updated.window_id],
        );
        await advanceWindow(db, updated.window_id);
      }
    });
  const events = await rows<{ id: string }>(
    pool,
    "SELECT id FROM domain_outbox WHERE state IN ('pending','processing') AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at LIMIT 50",
  );
  for (const item of events) {
    const event = await tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(724992)");
      return one<DomainEvent>(
        db,
        "UPDATE domain_outbox SET state='processing',lease_until=now()+interval '30 seconds',fence=fence+1,attempts=attempts+1 WHERE id=$1 AND state IN ('pending','processing') AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) RETURNING *",
        [item.id],
      );
    });
    if (!event) continue;
    try {
      await tx(async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(724992)");
        await processOutboxEvent(db, event);
      });
    } catch (error) {
      const terminal = event.attempts >= 8;
      await pool.query(
        "UPDATE domain_outbox SET state=$3,available_at=now()+make_interval(secs=>$4),lease_until=NULL,last_error=$5 WHERE id=$1 AND fence=$2",
        [
          event.id,
          event.fence,
          terminal ? "dead" : "pending",
          Math.min(1800, 5 * 2 ** Math.min(8, event.attempts)),
          error instanceof Error ? error.name : "UNKNOWN",
        ],
      );
    }
  }
}

const activeRequestStatuses = [
  "active",
  "paused",
  "paused_channel_unavailable",
  "suspended_incompatible",
];
