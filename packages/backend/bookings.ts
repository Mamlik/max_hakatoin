import { checkReward, loyaltyOutcome } from "./loyalty.js";
import { createHmac } from "node:crypto";
import { one, rows, type DB } from "../db/db.js";
import type {
  Actor,
  Booking,
  Customer,
  Staff,
  Service,
  Tenant,
  Voucher,
  QuoteIntent,
  Campaign,
  CampaignVersion,
} from "./types.js";
import { fail, required, version } from "./errors.js";
import { checkSlot } from "./scheduling.js";
import { canonical, hash, equalSecret } from "./auth.js";
import { config } from "./config.js";
import { audit } from "./http.js";
import { bookingEvent, notify } from "./notifications.js";

export async function voucherCheck(
  db: DB,
  voucherId: string,
  userId: string | null,
  tenantId: string,
  serviceId: string,
  startAt: string,
  price: number,
  existingBooking?: string,
) {
  const v = required(
    await one<Voucher>(
      db,
      "SELECT * FROM vouchers WHERE id=$1 AND user_id=$2 AND target_tenant_id=$3",
      [voucherId, userId, tenantId],
    ),
  );
  if (
    !(
      v.status === "issued" ||
      (v.status === "reserved" && v.reserved_booking_id === existingBooking)
    ) ||
    v.expires_at.getTime() <= Date.now() ||
    new Date(startAt) >= v.expires_at ||
    new Date(startAt) < v.issued_at ||
    !v.target_service_ids.includes(serviceId) ||
    v.discount_minor > price
  )
    fail(
      409,
      "VOUCHER_UNAVAILABLE",
      "Купон не подходит по услуге, сроку или уже использован",
    );
  return v;
}
export async function createQuote(
  db: DB,
  actor: Actor,
  tenant: Tenant,
  input: {
    serviceId: string;
    staffId: string;
    startAt: string;
    voucherId?: string | null;
    loyaltyRewardId?: string | null;
    customerId?: string;
    expectedVersion?: number;
    removeVoucher?: boolean;
  },
  work: boolean,
  existing?: Booking,
) {
  if (existing) {
    version(existing, input.expectedVersion);
    if (
      existing.status !== "confirmed" ||
      existing.start_at.getTime() <= Date.now()
    )
      fail(
        409,
        "INVALID_STATE_TRANSITION",
        "Перенос доступен только до начала подтверждённого визита",
      );
  } else if (tenant.status !== "published")
    fail(409, "TENANT_UNAVAILABLE", "Салон сейчас не принимает новые записи");
  const service = required(
    await one<Service>(
      db,
      "SELECT * FROM services WHERE id=$1 AND tenant_id=$2",
      [input.serviceId, tenant.id],
    ),
  );
  const staff = required(
    await one<Staff>(db, "SELECT * FROM staff WHERE id=$1 AND tenant_id=$2", [
      input.staffId,
      tenant.id,
    ]),
  );
  let customer: Customer;
  if (existing)
    customer = required(
      await one<Customer>(
        db,
        "SELECT * FROM customers WHERE id=$1 AND tenant_id=$2",
        [existing.customer_id, tenant.id],
      ),
    );
  else if (work)
    customer = required(
      await one<Customer>(
        db,
        "SELECT * FROM customers WHERE id=$1 AND tenant_id=$2",
        [input.customerId, tenant.id],
      ),
    );
  else {
    if (input.customerId)
      fail(
        422,
        "VALIDATION_ERROR",
        "При самостоятельной записи клиент определяется по сессии",
      );
    customer = (await one<Customer>(
      db,
      "INSERT INTO customers(tenant_id,user_id,display_name) VALUES($1,$2,$3) ON CONFLICT(tenant_id,user_id) WHERE user_id IS NOT NULL DO UPDATE SET user_id=EXCLUDED.user_id RETURNING *",
      [tenant.id, actor.id, actor.display_name],
    ))!;
  }
  const sameService = existing?.service_id === service.id;
  const duration = sameService
    ? existing!.duration_snapshot
    : service.duration_min;
  const price = sameService
    ? existing!.price_minor_snapshot
    : service.price_minor;
  const end = await checkSlot(
    db,
    tenant,
    service,
    staff,
    input.startAt,
    duration,
    existing?.id,
  );
  const voucherId = input.removeVoucher
    ? null
    : (input.voucherId ?? existing?.applied_voucher_id ?? null);
  const loyaltyRewardId =
    input.loyaltyRewardId ?? existing?.loyalty_reward_id ?? null;
  if (
    existing?.loyalty_reward_id &&
    loyaltyRewardId !== existing.loyalty_reward_id
  )
    fail(
      409,
      "LOYALTY_REWARD_UNAVAILABLE",
      "Для замены награды отмените запись и создайте новую.",
    );
  if (loyaltyRewardId && voucherId)
    fail(
      422,
      "VALIDATION_ERROR",
      "Бесплатный визит нельзя объединять с партнёрским купоном.",
    );
  if (loyaltyRewardId)
    await checkReward(
      db,
      loyaltyRewardId,
      tenant.id,
      customer.id,
      service.id,
      existing?.id,
    );
  let voucher: Voucher | undefined;
  if (voucherId) {
    try {
      voucher = await voucherCheck(
        db,
        voucherId,
        customer.user_id,
        tenant.id,
        service.id,
        input.startAt,
        price,
        existing?.id,
      );
    } catch (e) {
      if (existing?.applied_voucher_id === voucherId)
        fail(
          409,
          "VOUCHER_REMOVAL_CONFIRMATION_REQUIRED",
          "При переносе скидка недоступна. Подтвердите получение расчёта без купона.",
          {
            oldTotalMinor:
              existing.price_minor_snapshot - existing.discount_minor,
            newTotalMinor: price,
          },
        );
      throw e;
    }
  }
  const intent: QuoteIntent = {
    serviceId: service.id,
    staffId: staff.id,
    startAt: new Date(input.startAt).toISOString(),
    endAt: end,
    customerId: customer.id,
    userId: customer.user_id,
    serviceVersion: service.version,
    staffVersion: staff.version,
    priceMinor: price,
    durationMin: duration,
    discountMinor: loyaltyRewardId ? price : (voucher?.discount_minor ?? 0),
    voucherId,
    loyaltyRewardId,
    serviceName: sameService ? existing!.service_name_snapshot : service.name,
    ...(existing
      ? {
          bookingId: existing.id,
          expectedVersion: existing.version,
          removeVoucher: !!input.removeVoucher,
        }
      : {}),
  };
  const quote = (await one<{ id: string; expires_at: Date }>(
    db,
    "INSERT INTO quotes(actor_id,tenant_id,intent) VALUES($1,$2,$3) RETURNING id,expires_at",
    [actor.id, tenant.id, JSON.stringify(intent)],
  ))!;
  return {
    ...quote,
    ...intent,
    totalMinor: price - intent.discountMinor,
    tenantName: tenant.name,
    staffName: staff.name,
    address: tenant.address,
    timezone: tenant.timezone,
    termsVersion: "booking-p0-v1",
  };
}
function challengeToken(
  actorId: string,
  quoteId: string,
  conflicts: Booking[],
) {
  const fp = hash(
    canonical(
      conflicts
        .map((b) => ({ id: b.id, version: b.version }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ),
  );
  return createHmac("sha256", config.MAX_BOT_TOKEN)
    .update(`${actorId}:${quoteId}:${fp}`)
    .digest("base64url");
}
export async function confirmQuote(
  db: DB,
  actor: Actor,
  tenant: Tenant,
  input: {
    quoteId: string;
    expectedVersion?: number;
    overlapChallengeToken?: string | null;
    confirmOverlap?: boolean;
    removeVoucher?: boolean;
  },
  work: boolean,
  existing?: Booking,
) {
  const quote = required(
    await one<{ id: string; intent: QuoteIntent; expires_at: Date }>(
      db,
      "SELECT * FROM quotes WHERE id=$1 AND actor_id=$2 AND tenant_id=$3",
      [input.quoteId, actor.id, tenant.id],
    ),
  );
  if (quote.expires_at.getTime() <= Date.now())
    fail(409, "QUOTE_EXPIRED", "Расчёт устарел. Выберите время заново.");
  const i = quote.intent;
  if (i.bookingId !== existing?.id)
    fail(409, "QUOTE_CHANGED", "Расчёт относится к другой записи");
  if (existing) {
    version(existing, input.expectedVersion);
    version(existing, i.expectedVersion);
    if (
      existing.status !== "confirmed" ||
      existing.start_at.getTime() <= Date.now()
    )
      fail(
        409,
        "INVALID_STATE_TRANSITION",
        "Перенос доступен только до начала",
      );
    if (i.removeVoucher && !input.removeVoucher)
      fail(
        409,
        "VOUCHER_REMOVAL_CONFIRMATION_REQUIRED",
        "Нужно подтвердить снятие скидки",
      );
  } else if (tenant.status !== "published")
    fail(409, "TENANT_UNAVAILABLE", "Новые записи временно недоступны");
  const customer = required(
    await one<Customer>(
      db,
      "SELECT * FROM customers WHERE id=$1 AND tenant_id=$2",
      [i.customerId, tenant.id],
    ),
  );
  if (!work && customer.user_id !== actor.id)
    fail(404, "NOT_FOUND", "Клиент недоступен");
  if (customer.user_id !== i.userId)
    fail(409, "QUOTE_CHANGED", "Карточка клиента изменилась");
  const service = required(
    await one<Service>(
      db,
      "SELECT * FROM services WHERE id=$1 AND tenant_id=$2",
      [i.serviceId, tenant.id],
    ),
  );
  const staff = required(
    await one<Staff>(db, "SELECT * FROM staff WHERE id=$1 AND tenant_id=$2", [
      i.staffId,
      tenant.id,
    ]),
  );
  if (service.version !== i.serviceVersion || staff.version !== i.staffVersion)
    fail(
      409,
      "QUOTE_CHANGED",
      "Услуга или график изменились. Получите новый расчёт.",
    );
  await checkSlot(
    db,
    tenant,
    service,
    staff,
    i.startAt,
    i.durationMin,
    existing?.id,
  );
  const conflicts = await rows<Booking>(
    db,
    "SELECT id,version FROM bookings WHERE user_id=$1 AND tenant_id<>$2 AND status='confirmed' AND start_at<$4 AND end_at>$3 AND ($5::uuid IS NULL OR id<>$5)",
    [i.userId, tenant.id, i.startAt, i.endAt, existing?.id ?? null],
  );
  if (conflicts.length) {
    const token = challengeToken(actor.id, quote.id, conflicts);
    if (
      !input.confirmOverlap ||
      !input.overlapChallengeToken ||
      !equalSecret(token, input.overlapChallengeToken)
    )
      fail(
        409,
        "CLIENT_OVERLAP_CONFIRMATION_REQUIRED",
        work
          ? "У клиента есть пересечение с другой записью. Продолжайте только после согласования с клиентом."
          : "На это время у вас уже есть запись в другом салоне. Можно выбрать другое время или продолжить.",
        { overlapChallengeToken: token },
      );
  }
  if (i.loyaltyRewardId)
    await checkReward(
      db,
      i.loyaltyRewardId,
      tenant.id,
      customer.id,
      i.serviceId,
      existing?.id,
    );
  if (i.voucherId)
    await voucherCheck(
      db,
      i.voucherId,
      i.userId,
      tenant.id,
      i.serviceId,
      i.startAt,
      i.priceMinor,
      existing?.id,
    );
  if (
    existing?.applied_voucher_id &&
    existing.applied_voucher_id !== i.voucherId
  )
    await releaseVoucher(db, existing, actor.id);
  let booking: Booking;
  if (existing)
    booking = (await one<Booking>(
      db,
      "UPDATE bookings SET staff_id=$2,service_id=$3,start_at=$4,end_at=$5,service_name_snapshot=$6,duration_snapshot=$7,price_minor_snapshot=$8,discount_minor=$9,applied_voucher_id=$10,version=version+1 WHERE id=$1 RETURNING *",
      [
        existing.id,
        i.staffId,
        i.serviceId,
        i.startAt,
        i.endAt,
        i.serviceName,
        i.durationMin,
        i.priceMinor,
        i.discountMinor,
        i.voucherId,
      ],
    ))!;
  else
    booking = (await one<Booking>(
      db,
      "INSERT INTO bookings(tenant_id,customer_id,user_id,staff_id,service_id,start_at,end_at,timezone_snapshot,source,service_name_snapshot,duration_snapshot,price_minor_snapshot,discount_minor,applied_voucher_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *",
      [
        tenant.id,
        customer.id,
        customer.user_id,
        i.staffId,
        i.serviceId,
        i.startAt,
        i.endAt,
        tenant.timezone,
        work ? "manual" : "self",
        i.serviceName,
        i.durationMin,
        i.priceMinor,
        i.discountMinor,
        i.voucherId,
        actor.id,
      ],
    ))!;
  if (i.loyaltyRewardId) {
    await db.query("UPDATE bookings SET loyalty_reward_id=$2 WHERE id=$1", [
      booking.id,
      i.loyaltyRewardId,
    ]);
    booking.loyalty_reward_id = i.loyaltyRewardId;
    await db.query(
      "UPDATE loyalty_rewards SET status='reserved',reserved_booking_id=$2 WHERE id=$1",
      [i.loyaltyRewardId, booking.id],
    );
    await audit(
      db,
      tenant.id,
      actor.id,
      "loyalty.reserved",
      i.loyaltyRewardId,
      { bookingId: booking.id },
    );
  }
  if (i.voucherId) {
    await db.query(
      "UPDATE vouchers SET status='reserved',reserved_booking_id=$2,version=version+1 WHERE id=$1",
      [i.voucherId, booking.id],
    );
    await voucherRevision(db, i.voucherId, "reserved", actor.id);
  }
  await bookingRevision(
    db,
    booking,
    actor.id,
    conflicts.length ? "Пересечение явно подтверждено" : null,
  );
  await audit(
    db,
    tenant.id,
    actor.id,
    existing ? "booking.rescheduled" : "booking.created",
    booking.id,
    { overlapConfirmed: conflicts.length > 0 },
  );
  await bookingEvent(db, booking, existing ? "rescheduled" : "created");
  return booking;
}
export async function bookingRevision(
  db: DB,
  b: Booking,
  actorId: string,
  reason: string | null,
) {
  await db.query(
    "INSERT INTO booking_revisions(tenant_id,booking_id,version,actor_id,reason,snapshot) VALUES($1,$2,$3,$4,$5,$6)",
    [b.tenant_id, b.id, b.version, actorId, reason, JSON.stringify(b)],
  );
}
export async function voucherRevision(
  db: DB,
  voucherId: string,
  action: string,
  actorId: string,
  reason?: string,
) {
  await db.query(
    "INSERT INTO voucher_revisions(voucher_id,action,actor_id,reason) VALUES($1,$2,$3,$4)",
    [voucherId, action, actorId, reason ?? null],
  );
}
export async function releaseVoucher(
  db: DB,
  booking: Booking,
  actorId: string,
) {
  if (!booking.applied_voucher_id) return;
  const v = required(
    await one<Voucher>(db, "SELECT * FROM vouchers WHERE id=$1", [
      booking.applied_voucher_id,
    ]),
  );
  if (v.status === "redeemed") return;
  await db.query(
    "UPDATE vouchers SET status=CASE WHEN expires_at<=now() THEN 'expired' ELSE 'issued' END,reserved_booking_id=NULL,version=version+1 WHERE id=$1 AND status='reserved'",
    [v.id],
  );
  await db.query(
    "UPDATE bookings SET previous_voucher_id=applied_voucher_id,applied_voucher_id=NULL,discount_minor=0 WHERE id=$1",
    [booking.id],
  );
  await voucherRevision(db, v.id, "released", actorId);
}
export async function issueVouchers(db: DB, booking: Booking, actorId: string) {
  if (!booking.user_id) return;
  const consent = await one(
    db,
    "SELECT 1 FROM users u JOIN preferences p ON p.user_id=u.id WHERE u.id=$1 AND u.partner_program_enabled AND p.tenant_id=$2 AND p.partner_allowed",
    [booking.user_id, booking.tenant_id],
  );
  if (!consent) return;
  const campaigns = await rows<Campaign>(
    db,
    "SELECT c.* FROM campaigns c JOIN tenants a ON a.id=c.source_tenant_id JOIN tenants b ON b.id=c.target_tenant_id WHERE c.source_tenant_id=$1 AND c.status='active' AND a.status='published' AND b.status='published' AND a.partner_enabled AND b.partner_enabled AND NOT EXISTS(SELECT 1 FROM campaign_pauses p WHERE p.campaign_id=c.id) ORDER BY c.id",
    [booking.tenant_id],
  );
  for (const c of campaigns) {
    const v = required(
      await one<CampaignVersion>(
        db,
        "SELECT * FROM campaign_versions WHERE id=$1",
        [c.active_version_id],
      ),
    );
    if (
      !v.source_service_ids.includes(booking.service_id) ||
      new Date() < v.issue_from ||
      new Date() >= v.issue_until ||
      c.issued_total >= v.issue_limit
    )
      continue;
    const voucher = await one<Voucher>(
      db,
      "INSERT INTO vouchers(campaign_id,version_id,source_booking_id,user_id,source_tenant_id,target_tenant_id,discount_minor,target_service_ids,terms_snapshot,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+$10*interval '24 hours') ON CONFLICT(user_id,source_booking_id,campaign_id) DO NOTHING RETURNING *",
      [
        c.id,
        v.id,
        booking.id,
        booking.user_id,
        c.source_tenant_id,
        c.target_tenant_id,
        v.discount_minor,
        v.target_service_ids,
        JSON.stringify({
          termsText: v.terms_text,
          discountMinor: v.discount_minor,
          targetServiceIds: v.target_service_ids,
          versionNumber: v.number,
        }),
        v.voucher_valid_days,
      ],
    );
    if (!voucher) continue;
    await db.query(
      "UPDATE campaigns SET issued_total=issued_total+1,version=version+1 WHERE id=$1",
      [c.id],
    );
    await voucherRevision(db, voucher.id, "issued", actorId);
    const names = await rows<{ id: string; name: string }>(
      db,
      "SELECT id,name FROM tenants WHERE id=ANY($1::uuid[])",
      [[c.source_tenant_id, c.target_tenant_id]],
    );
    await notify(
      db,
      booking.user_id,
      c.source_tenant_id,
      "voucher.issued",
      voucher.id,
      "Новое партнёрское предложение",
      `${names.find((n) => n.id === c.source_tenant_id)!.name}: скидка ${v.discount_minor / 100} ₽ в ${names.find((n) => n.id === c.target_tenant_id)!.name}`,
      {
        category: "offer",
        notAfter: new Date(
          Math.min(voucher.expires_at.getTime(), Date.now() + 86400000),
        ),
      },
    );
  }
}
export async function outcome(
  db: DB,
  actor: Actor,
  booking: Booking,
  target: string,
  reason?: string,
  correction = false,
  restorePreviousVoucher = false,
) {
  if (correction) {
    if (
      !["completed", "no_show"].includes(booking.status) ||
      !["completed", "no_show", "cancelled"].includes(target) ||
      target === booking.status
    )
      fail(
        409,
        "INVALID_STATE_TRANSITION",
        "Этот исход нельзя исправить указанным способом",
      );
    if (!reason?.trim())
      fail(422, "VALIDATION_ERROR", "Укажите причину исправления");
    const consequences = await rows<Voucher>(
      db,
      "SELECT * FROM vouchers WHERE source_booking_id=$1",
      [booking.id],
    );
    if (
      target === "cancelled" &&
      consequences.some((v) => ["reserved", "redeemed"].includes(v.status))
    )
      fail(
        409,
        "PARTNER_REVIEW_REQUIRED",
        "Есть зарезервированные или использованные купоны. Требуется разбор партнёрского обязательства.",
      );
    if (target !== "completed")
      for (const v of consequences) {
        if (v.status === "issued") {
          await db.query(
            "UPDATE vouchers SET status='revoked',version=version+1 WHERE id=$1",
            [v.id],
          );
          await voucherRevision(db, v.id, "revoked", actor.id, reason);
          await notify(
            db,
            v.user_id,
            v.source_tenant_id,
            "voucher.revoked",
            v.id,
            "Купон отозван",
            reason!,
          );
        } else if (["reserved", "redeemed"].includes(v.status))
          await db.query(
            "INSERT INTO partner_exceptions(voucher_id,reason) VALUES($1,$2)",
            [v.id, reason],
          );
      }
    if (target === "completed" && booking.previous_voucher_id) {
      if (!restorePreviousVoucher)
        fail(
          409,
          "PARTNER_REVIEW_REQUIRED",
          "Для восстановления прежней скидки требуется явное подтверждение владельца",
        );
      const v = await voucherCheck(
        db,
        booking.previous_voucher_id,
        booking.user_id,
        booking.tenant_id,
        booking.service_id,
        booking.start_at.toISOString(),
        booking.price_minor_snapshot,
      );
      await db.query(
        "UPDATE vouchers SET status='redeemed',reserved_booking_id=NULL,redeemed_booking_id=$2,version=version+1 WHERE id=$1",
        [v.id, booking.id],
      );
      await db.query(
        "UPDATE bookings SET applied_voucher_id=$2,discount_minor=$3 WHERE id=$1",
        [booking.id, v.id, v.discount_minor],
      );
      await voucherRevision(db, v.id, "redeemed_correction", actor.id, reason);
    }
  } else {
    if (booking.status !== "confirmed")
      fail(409, "INVALID_STATE_TRANSITION", "Запись уже имеет итоговый статус");
    if (target !== "cancelled" && booking.start_at.getTime() > Date.now())
      fail(
        409,
        "INVALID_STATE_TRANSITION",
        "Отметить исход можно только после начала визита",
      );
    if (target === "completed" && booking.applied_voucher_id) {
      const v = required(
        await one<Voucher>(db, "SELECT * FROM vouchers WHERE id=$1", [
          booking.applied_voucher_id,
        ]),
      );
      if (v.status !== "reserved" || v.reserved_booking_id !== booking.id)
        fail(
          409,
          "VOUCHER_UNAVAILABLE",
          "Резерв купона не соответствует записи",
        );
      await db.query(
        "UPDATE vouchers SET status='redeemed',redeemed_booking_id=$2,reserved_booking_id=NULL,version=version+1 WHERE id=$1",
        [v.id, booking.id],
      );
      await voucherRevision(db, v.id, "redeemed", actor.id);
    }
    if (target === "cancelled" || target === "no_show")
      await releaseVoucher(db, booking, actor.id);
  }
  await loyaltyOutcome(db, booking, target, actor.id);
  const updated = (await one<Booking>(
    db,
    "UPDATE bookings SET status=$2,version=version+1,outcome_at=now() WHERE id=$1 RETURNING *",
    [booking.id, target],
  ))!;
  if (target === "completed" && !correction)
    await issueVouchers(db, updated, actor.id);
  await bookingRevision(db, updated, actor.id, reason ?? null);
  await audit(
    db,
    booking.tenant_id,
    actor.id,
    correction ? "booking.outcome_corrected" : `booking.${target}`,
    booking.id,
    { reason, target },
  );
  await bookingEvent(db, updated, correction ? "corrected" : target);
  return updated;
}
