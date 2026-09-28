import { Queue, Worker } from "bullmq";
import { DateTime } from "luxon";
import { config } from "../../packages/backend/config.js";
import { pool, one, rows, tx, type DB } from "../../packages/db/db.js";
import {
  redis,
  sendMessage,
  maxRequest,
  MaxError,
} from "../../packages/max-api/client.js";
import { notify } from "../../packages/backend/notifications.js";
import { snapshotDays } from "../../packages/backend/scheduling.js";
import type { Tenant } from "../../packages/backend/types.js";
import {
  advanceWindow,
  runLiveWindowCycle,
} from "../../packages/backend/live-window.js";

interface Delivery {
  id: string;
  notification_id: string;
  user_id: string;
  tenant_id: string | null;
  booking_id: string | null;
  booking_version: number | null;
  category: string;
  membership_id: string | null;
  generation: number;
  state: string;
  due_at: Date;
  not_after: Date;
  attempts: number;
  fence: number;
  max_user_id: string;
  title: string;
  body: string;
  object_id: string | null;
  kind: string;
  live_window_offer_id: string | null;
}
export async function eligible(db: DB, d: Delivery): Promise<string | null> {
  if (d.not_after.getTime() <= Date.now()) return "EXPIRED";
  const channel = await one<{ state: string; generation: number }>(
    db,
    "SELECT state,generation FROM bot_channels WHERE user_id=$1",
    [d.user_id],
  );
  if (channel?.state !== "active" || channel.generation !== d.generation)
    return "CHANNEL_UNAVAILABLE";
  if (d.booking_id) {
    const b = await one<{ version: number; status: string }>(
      db,
      "SELECT version,status FROM bookings WHERE id=$1",
      [d.booking_id],
    );
    if (!b || b.version !== d.booking_version) return "SUPERSEDED";
    if (d.category === "reminder" && b.status !== "confirmed")
      return "SUPERSEDED";
  }
  if (d.live_window_offer_id) {
    const offer = await one(
      db,
      `SELECT o.id FROM live_window_offers o
       JOIN live_windows w ON w.id=o.window_id AND w.tenant_id=o.tenant_id
       JOIN waitlist_requests r ON r.id=o.request_id AND r.tenant_id=o.tenant_id
       JOIN live_window_settings s ON s.tenant_id=o.tenant_id
       WHERE o.id=$1 AND o.status='pending_delivery' AND r.status='active'
         AND w.status='offering' AND w.start_at>now() AND s.enabled AND NOT s.paused
         AND COALESCE((SELECT (value->>'enabled')::boolean FROM system_state WHERE key='live_window_allowlist'),false)
         AND NOT COALESCE((SELECT (value->>'enabled')::boolean FROM system_state WHERE key='live_window_kill_switch'),false)`,
      [d.live_window_offer_id],
    );
    if (!offer) return "LIVE_WINDOW_SUPPRESSED";
  }
  if (d.category === "welcome") return null;
  if (d.category === "work") {
    if (!d.membership_id) return "WORK_PREFERENCE_DISABLED";
    const m = await one(
      db,
      "SELECT id FROM memberships WHERE id=$1 AND user_id=$2 AND status='active' AND notifications_enabled",
      [d.membership_id, d.user_id],
    );
    return m ? null : "ACCESS_OR_PREFERENCE_REVOKED";
  }
  const p = await one<{
    service_bot_enabled: boolean;
    reminder_bot_enabled: boolean;
    offer_bot_enabled: boolean;
    partner_allowed: boolean;
    partner_program_enabled: boolean;
  }>(
    db,
    "SELECT p.*,u.partner_program_enabled FROM preferences p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1 AND p.tenant_id=$2",
    [d.user_id, d.tenant_id],
  );
  if (!p) return "CONSENT_MISSING";
  if (
    d.category === "offer" &&
    (!p.offer_bot_enabled || !p.partner_allowed || !p.partner_program_enabled)
  )
    return "CONSENT_REVOKED";
  if (d.category === "live_window" && !p.offer_bot_enabled)
    return "OFFER_NOTIFICATIONS_DISABLED";
  if (d.category === "reminder" && !p.reminder_bot_enabled)
    return "REMINDERS_DISABLED";
  if (d.category === "service" && !p.service_bot_enabled)
    return "SERVICE_DISABLED";
  return null;
}
export async function processDelivery(id: string) {
  const d = await one<Delivery>(
    pool,
    "UPDATE deliveries SET state='sending',lease_until=now()+interval '30 seconds',fence=fence+1 WHERE id=$1 AND state IN ('scheduled','retry_wait') AND due_at<=now() RETURNING *",
    [id],
  );
  if (!d) return;
  const meta = await one<{
    max_user_id: string;
    title: string;
    body: string;
    object_id: string | null;
    kind: string;
  }>(
    pool,
    "SELECT u.max_user_id,n.title,n.body,n.object_id,n.kind FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.id=$1",
    [d.notification_id],
  );
  Object.assign(d, meta);
  const invalid = await eligible(pool, d);
  if (invalid) {
    await pool.query(
      "UPDATE deliveries SET state='suppressed',last_error=$3,lease_until=NULL WHERE id=$1 AND fence=$2",
      [id, d.fence, invalid],
    );
    await failLiveWindowDelivery(d, invalid);
    return;
  }
  try {
    const fresh = await eligible(pool, d);
    if (fresh) {
      await pool.query(
        "UPDATE deliveries SET state='suppressed',last_error=$3 WHERE id=$1 AND fence=$2",
        [id, d.fence, fresh],
      );
      await failLiveWindowDelivery(d, fresh);
      return;
    }
    const payload = d.live_window_offer_id
      ? `lw_${d.live_window_offer_id}`
      : d.kind.startsWith("loyalty.")
      ? "loyalty"
      : d.booking_id
        ? `b_${d.booking_id}`
        : d.kind.startsWith("voucher.") &&
            d.kind !== "voucher.revocation_request"
          ? `v_${d.object_id}`
          : d.tenant_id
            ? `s_${(await one<{ public_code: string }>(pool, "SELECT public_code FROM tenants WHERE id=$1", [d.tenant_id]))!.public_code}`
            : "home";
    const result = await sendMessage(
      d.max_user_id,
      `${d.title}\n${d.body}`,
      payload,
    );
    const message = result.message as { body?: { mid?: unknown } } | undefined;
    await pool.query(
      "UPDATE deliveries SET state='sent',sent_at=now(),lease_until=NULL,attempts=attempts+1,max_message_id=$3,last_error=NULL WHERE id=$1 AND fence=$2",
      [id, d.fence, String(message?.body?.mid ?? "accepted")],
    );
    await pool.query(
      "INSERT INTO delivery_attempts(delivery_id,attempt,result) VALUES($1,$2,'sent')",
      [id, d.attempts + 1],
    );
    if (d.live_window_offer_id)
      await tx(async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(724992)");
        await db.query(
          `UPDATE live_window_offers o SET status='offered',offered_at=now(),
             expires_at=now()+make_interval(mins=>s.offer_ttl_minutes),version=o.version+1,updated_at=now()
             FROM live_window_settings s
            WHERE o.id=$1 AND o.tenant_id=s.tenant_id AND o.status='pending_delivery'`,
          [d.live_window_offer_id],
        );
      });
  } catch (e) {
    const error =
      e instanceof MaxError ? e : new MaxError("TRANSPORT_UNAVAILABLE", 5000);
    const limited = error.code === "RATE_LIMITED";
    const attempts = d.attempts + (limited ? 0 : 1);
    const backoff =
      [5000, 30000, 120000, 600000, 1800000][Math.min(4, attempts - 1)] ?? 5000;
    const delay = Math.max(
      error.retryAfterMs,
      Math.floor(backoff * (0.8 + Math.random() * 0.4)),
    );
    const next = new Date(Date.now() + (limited ? error.retryAfterMs : delay));
    const state =
      error.permanent || attempts >= 6
        ? "failed"
        : next >= d.not_after
          ? "suppressed"
          : "retry_wait";
    await pool.query(
      "UPDATE deliveries SET state=$3,attempts=$4,due_at=$5,lease_until=NULL,last_error=$6 WHERE id=$1 AND fence=$2",
      [id, d.fence, state, attempts, next, error.code],
    );
    if (!limited)
      await pool.query(
        "INSERT INTO delivery_attempts(delivery_id,attempt,result) VALUES($1,$2,$3)",
        [id, attempts, error.code],
      );
    if (d.live_window_offer_id && ["failed", "suppressed"].includes(state))
      await failLiveWindowDelivery(d, error.code);
  }
}
async function failLiveWindowDelivery(d: Delivery, reason: string) {
  if (!d.live_window_offer_id) return;
  await tx(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(724992)");
    const offer = await one<{ window_id: string }>(
      db,
      "UPDATE live_window_offers SET status='delivery_failed',terminal_reason=$2,version=version+1,updated_at=now() WHERE id=$1 AND status='pending_delivery' RETURNING window_id",
      [d.live_window_offer_id, reason],
    );
    if (offer) {
      await db.query(
        "UPDATE live_windows SET status='matching',version=version+1,updated_at=now() WHERE id=$1 AND status='offering'",
        [offer.window_id],
      );
      await advanceWindow(db, offer.window_id);
    }
  });
}
export async function processInbox() {
  await tx(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(724992)");
    const updates = await rows<{
      event_key: string;
      payload: Record<string, unknown>;
    }>(
      db,
      "SELECT * FROM max_inbox WHERE processed_at IS NULL ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED",
    );
    for (const update of updates) {
      const p = update.payload;
      const type = String(p.update_type);
      const state = (
        {
          bot_started: "active",
          bot_stopped: "stopped",
          dialog_removed: "removed",
        } as Record<string, string>
      )[type];
      if (state) {
        const user = p.user as Record<string, unknown> | undefined;
        const rawId = user?.user_id ?? user?.id ?? p.user_id;
        const maxId = String(rawId ?? "");
        const timestamp = Number(p.timestamp ?? 0);
        if (
          /^[1-9]\d{0,18}$/.test(maxId) &&
          BigInt(maxId) <= 9223372036854775807n &&
          Number.isSafeInteger(timestamp) &&
          timestamp > 0
        ) {
          const u = (await one<{ id: string }>(
            db,
            "INSERT INTO users(max_user_id,display_name) VALUES($1,$2) ON CONFLICT(max_user_id) DO UPDATE SET max_user_id=EXCLUDED.max_user_id RETURNING id",
            [
              maxId,
              typeof user?.name === "string"
                ? user.name.slice(0, 120)
                : "Пользователь MAX",
            ],
          ))!;
          const rank = state === "removed" ? 3 : state === "stopped" ? 2 : 1;
          const old = await one<{
            event_timestamp: string;
            event_rank: number;
            generation: number;
          }>(db, "SELECT * FROM bot_channels WHERE user_id=$1", [u.id]);
          if (
            !old ||
            timestamp > Number(old.event_timestamp) ||
            (timestamp === Number(old.event_timestamp) && rank > old.event_rank)
          ) {
            await db.query(
              "INSERT INTO bot_channels(user_id,state,event_timestamp,event_rank,generation) VALUES($1,$2,$3,$4,1) ON CONFLICT(user_id) DO UPDATE SET state=$2,event_timestamp=$3,event_rank=$4,generation=bot_channels.generation+1",
              [u.id, state, timestamp, rank],
            );
            await db.query(
              "UPDATE deliveries SET state='suppressed',last_error='CHANNEL_GENERATION_CHANGED' WHERE user_id=$1 AND state IN ('scheduled','retry_wait')",
              [u.id],
            );
            if (state === "active")
              await db.query(
                `UPDATE waitlist_requests r SET status='active',suspension_reason=NULL,version=r.version+1,updated_at=now()
                 WHERE r.user_id=$1 AND r.status='paused_channel_unavailable' AND r.expires_at>now()
                   AND EXISTS(SELECT 1 FROM live_window_settings s WHERE s.tenant_id=r.tenant_id AND s.enabled AND NOT s.paused)
                   AND COALESCE((SELECT (value->>'enabled')::boolean FROM system_state WHERE key='live_window_allowlist'),false)
                   AND NOT COALESCE((SELECT (value->>'enabled')::boolean FROM system_state WHERE key='live_window_kill_switch'),false)`,
                [u.id],
              );
            else {
              const offers = await rows<{ id: string; window_id: string }>(
                db,
                "UPDATE live_window_offers SET status='revoked',terminal_reason='CHANNEL_UNAVAILABLE',version=version+1,updated_at=now() WHERE user_id=$1 AND status IN ('pending_delivery','offered') RETURNING id,window_id",
                [u.id],
              );
              await db.query(
                "UPDATE waitlist_requests SET status='paused_channel_unavailable',suspension_reason='MAX_CHANNEL_UNAVAILABLE',version=version+1,updated_at=now() WHERE user_id=$1 AND status='active'",
                [u.id],
              );
              for (const offer of offers) {
                await db.query(
                  "UPDATE deliveries SET state='suppressed',last_error='CHANNEL_UNAVAILABLE' WHERE live_window_offer_id=$1 AND state IN ('scheduled','retry_wait')",
                  [offer.id],
                );
                await db.query(
                  "UPDATE live_windows SET status='matching',version=version+1,updated_at=now() WHERE id=$1 AND status='offering'",
                  [offer.window_id],
                );
                await advanceWindow(db, offer.window_id);
              }
            }
            if (state === "active")
              await notify(
                db,
                u.id,
                null,
                "bot.welcome",
                null,
                "Салоны в MAX",
                "Откройте приложение: записи, услуги и предложения ваших салонов. Настройки сообщений включаются отдельно.",
                {
                  category: "welcome",
                  notAfter: new Date(Date.now() + 300000),
                },
              );
          }
        }
      }
      await db.query(
        "UPDATE max_inbox SET processed_at=now() WHERE event_key=$1",
        [update.event_key],
      );
    }
  });
}
let queue: Queue | undefined,
  worker: Worker | undefined,
  timer: NodeJS.Timeout | undefined;
let running = false,
  lastSnapshots = 0,
  lastSubscription = 0;
async function tick() {
  if (running) return;
  running = true;
  try {
    await processInbox();
    await runLiveWindowCycle();
    await tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(724992)");
      await db.query(
        "UPDATE vouchers SET status='expired',version=version+1 WHERE status='issued' AND expires_at<=now()",
      );
      await db.query(
        "UPDATE invites SET status='expired',version=version+1 WHERE status IN ('pending','client_confirmed') AND expires_at<=now()",
      );
      await db.query(
        "UPDATE revocation_requests SET status='expired',version=version+1 WHERE status='pending' AND expires_at<=now()",
      );
      await db.query(
        "UPDATE deliveries SET state='retry_wait',due_at=now(),last_error='LEASE_EXPIRED_UNKNOWN',lease_until=NULL WHERE state='sending' AND lease_until<now()",
      );
    });
    const due = await rows<{ id: string }>(
      pool,
      "SELECT id FROM deliveries WHERE state IN ('scheduled','retry_wait') AND due_at<=now() ORDER BY due_at LIMIT 100",
    );
    for (const d of due) {
      await queue!.add(
        "deliver",
        { id: d.id },
        {
          jobId: `delivery-${d.id}`,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      await pool.query(
        "UPDATE outbox SET published_at=now() WHERE delivery_id=$1 AND published_at IS NULL",
        [d.id],
      );
    }
    // One short transaction per master. Sweeping every tenant inside a single transaction held the
    // shared write gate for the whole run (~50 ms per master), stalling every booking platform-wide.
    if (Date.now() - lastSnapshots > 3600000) {
      const tenants = await rows<Tenant>(
        pool,
        "SELECT * FROM tenants WHERE status<>'archived'",
      );
      for (const t of tenants) {
        const staff = await rows<{ id: string }>(
          pool,
          "SELECT id FROM staff WHERE tenant_id=$1 AND active",
          [t.id],
        );
        const from = DateTime.now()
          .setZone(t.timezone)
          .minus({ days: 1 })
          .toISODate()!;
        for (const s of staff)
          await tx(async (db) => {
            await db.query("SELECT pg_advisory_xact_lock(724992)");
            await snapshotDays(db, t, s.id, from, 32);
          });
      }
      lastSnapshots = Date.now();
    }
    if (config.MAX_MODE === "real" && Date.now() - lastSubscription > 300000) {
      try {
        const data = await maxRequest("GET", "/subscriptions");
        const subscriptions = data.subscriptions as
          | { url: string }[]
          | undefined;
        const found =
          subscriptions?.some(
            (s) =>
              s.url === `${config.PUBLIC_APP_URL}/integrations/max/webhook`,
          ) ?? false;
        await pool.query(
          "INSERT INTO system_state(key,value) VALUES('max_subscription',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=now()",
          [JSON.stringify({ active: found })],
        );
        lastSubscription = Date.now();
      } catch (e) {
        if (!(e instanceof MaxError && e.code === "RATE_LIMITED"))
          lastSubscription = Date.now();
      }
    }
    await pool.query(
      "INSERT INTO system_state(key,value) VALUES('worker',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=now()",
      [JSON.stringify({ status: "ready", maxMode: config.MAX_MODE })],
    );
  } catch (e) {
    console.error(
      JSON.stringify({
        component: "worker",
        status: "degraded",
        errorType: e instanceof Error ? e.name : "unknown",
      }),
    );
  } finally {
    running = false;
  }
}
export async function startWorker() {
  if (redis.status === "wait") await redis.connect();
  queue = new Queue("max-deliveries", { connection: redis });
  worker = new Worker(
    "max-deliveries",
    async (job) => processDelivery(String(job.data.id)),
    { connection: redis, concurrency: 4 },
  );
  worker.on("error", () => {});
  queue.on("error", () => {});
  timer = setInterval(() => void tick(), 3000);
  await tick();
}
if (!process.env.VITEST) {
  await startWorker();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      if (timer) clearInterval(timer);
      await worker?.close();
      await queue?.close();
      await redis.quit();
      await pool.end();
      process.exit(0);
    });
}
