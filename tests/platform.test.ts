import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { DateTime } from "luxon";
import { createApp } from "../apps/api/main.js";
import { pool, one, rows, tx } from "../packages/db/db.js";
import { seed, fixtureId as f } from "../packages/db/seed.js";
import { signInitData } from "../packages/backend/auth.js";
import { config } from "../packages/backend/config.js";
import { processDelivery, processInbox } from "../apps/worker/main.js";
import {
  advanceWindow,
  runLiveWindowCycle,
} from "../packages/backend/live-window.js";
import { redis } from "../packages/max-api/client.js";
import type { Campaign as CampaignDB } from "../packages/backend/types.js";
let app: NestFastifyApplication;
interface Result<T> {
  status: number;
  data: T;
  error: { code: string; message: string; details: Record<string, unknown> };
}
async function req<T = Record<string, unknown>>(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  key: string = randomUUID(),
): Promise<Result<T>> {
  const r = await app.inject({
    method: method as "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: path,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "idempotency-key": key,
    },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  const json = r.json() as { data: T; error: Result<T>["error"] };
  return { status: r.statusCode, ...json };
}
async function login(persona = "client") {
  const ids: Record<string, string> = {
    client: "900001",
    "owner-a": "900002",
    "owner-b": "900003",
    admin: "900004",
    master: "900005",
    new: "900006",
  };
  const raw = signInitData({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: ids[persona] ?? persona, first_name: "Test" }),
  });
  return (
    await req<{ sessionToken: string }>("POST", "/api/v1/auth/max", undefined, {
      initData: raw,
    })
  ).data.sessionToken;
}
const tomorrow = (hour = 10) =>
  DateTime.now()
    .setZone("Europe/Moscow")
    .plus({ days: 1 })
    .set({ hour, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!;
async function quote(
  token: string,
  salon = "a",
  hour = 10,
  extra: Record<string, unknown> = {},
) {
  const response = await req<{ id: string }>(
    "POST",
    `/api/v1/salons/${f(`salon-${salon}`)}/booking-quotes`,
    token,
    {
      serviceId: f(`service-${salon}-0`),
      staffId: f(`staff-${salon}-0`),
      startAt: tomorrow(hour),
      ...extra,
    },
  );
  expect(response.status, JSON.stringify(response.error)).toBe(201);
  return response.data.id;
}
async function book(
  token: string,
  q: string,
  salon = "a",
  extra: Record<string, unknown> = {},
  key?: string,
) {
  return req<{ id: string; version: number; discountMinor: number }>(
    "POST",
    `/api/v1/salons/${f(`salon-${salon}`)}/bookings`,
    token,
    { quoteId: q, confirmedTermsVersion: "booking-p0-v1", ...extra },
    key,
  );
}
beforeAll(async () => {
  const dbName = (
    await pool.query<{ name: string }>("SELECT current_database() name")
  ).rows[0]!.name;
  if (!dbName.endsWith("_test"))
    throw new Error("Integration tests require a database ending in _test");
  if (
    !(await one(
      pool,
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users'",
    ))
  )
    await pool.query(
      await readFile(
        new URL("../packages/db/migrations/001_initial.sql", import.meta.url),
        "utf8",
      ),
    );
  if (
    !(await one(
      pool,
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='loyalty_programs'",
    ))
  )
    await pool.query(
      await readFile(
        new URL("../packages/db/migrations/002_loyalty.sql", import.meta.url),
        "utf8",
      ),
    );
  if (
    !(await one(
      pool,
      "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='cover_media_id'",
    ))
  )
    await pool.query(
      await readFile(
        new URL(
          "../packages/db/migrations/003_catalog_media.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  if (
    !(await one(
      pool,
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='waitlist_requests'",
    ))
  )
    await pool.query(
      await readFile(
        new URL("../packages/db/migrations/004_live_window.sql", import.meta.url),
        "utf8",
      ),
    );
  if (
    !(await one(
      pool,
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='visit_reviews'",
    ))
  )
    await pool.query(
      await readFile(
        new URL("../packages/db/migrations/005_visit_reviews.sql", import.meta.url),
        "utf8",
      ),
    );
  app = await createApp();
});
beforeEach(async () => {
  await pool.query("TRUNCATE users,tenants,system_state,max_inbox CASCADE");
  await seed();
});
afterAll(async () => {
  await app?.close();
  await pool.end();
  redis.disconnect();
});
describe("booking and access invariants on PostgreSQL", () => {
  it("returns published salon media in the familiar salons carousel", async () => {
    const client = await login();
    const salonId = f("salon-a");
    const logoId = randomUUID();
    const coverId = randomUUID();
    await pool.query(
      "INSERT INTO media_assets(id,tenant_id,purpose,file_key,published) VALUES($1,$2,'logo',$3,true),($4,$2,'cover',$5,true)",
      [logoId, salonId, "published/test-logo.png", coverId, "published/test-cover.png"],
    );
    await pool.query(
      "UPDATE tenants SET published_style=published_style || $2::jsonb WHERE id=$1",
      [salonId, JSON.stringify({ logoMediaId: logoId, coverMediaId: coverId })],
    );

    const result = await req<{
      items: Array<{
        id: string;
        name: string;
        style: { logoMediaId: string; coverMediaId: string };
        media: Array<{ id: string; fileKey: string }>;
      }>;
    }>("GET", "/api/v1/me/salons", client);

    expect(result.status).toBe(200);
    const salon = result.data.items.find((item) => item.id === salonId);
    expect(salon).toMatchObject({
      name: "Линия · студия волос",
      style: { logoMediaId: logoId, coverMediaId: coverId },
    });
    expect(salon?.media).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: logoId, fileKey: "published/test-logo.png" }),
        expect.objectContaining({ id: coverId, fileKey: "published/test-cover.png" }),
      ]),
    );
  });

  it("creates a salon without seed and publishes after service/staff/schedule setup", async () => {
    const token = await login("new");
    const t = await req<{ id: string; version: number }>(
      "POST",
      "/api/v1/tenants",
      token,
      {
        name: "Новый салон",
        category: "Тест",
        address: "Тестовый адрес",
        contact: "Тестовый контакт",
        timezone: "Europe/Moscow",
      },
    );
    expect(t.status).toBe(201);
    const root = `/api/v1/work/${t.data.id}`;
    expect(
      (await req("POST", `${root}/publish`, token, { expectedVersion: 1 }))
        .status,
    ).toBe(422);
    const s = await req<{ id: string }>("POST", `${root}/services`, token, {
      name: "Услуга",
      durationMin: 60,
      priceMinor: 100000,
    });
    const staff = await req<{ id: string }>("POST", `${root}/staff`, token, {
      name: "Мастер",
    });
    await req("PUT", `${root}/staff/${staff.data.id}/services`, token, {
      expectedVersion: 1,
      serviceIds: [s.data.id],
    });
    const schedule = await req(
      "PUT",
      `${root}/staff/${staff.data.id}/schedule`,
      token,
      {
        expectedVersion: 2,
        effectiveFrom: DateTime.now().plus({ days: 1 }).toISODate(),
        weekly: Array.from({ length: 7 }, (_, i) => ({
          weekday: i + 1,
          intervals: [{ kind: "work", start: "09:00", end: "18:00" }],
        })),
      },
    );
    expect(schedule.status, JSON.stringify(schedule.error)).toBe(200);
    expect(
      (await req("POST", `${root}/publish`, token, { expectedVersion: 1 }))
        .status,
    ).toBe(201);
  });
  it("serializes 20 competing confirmations: exactly one booking", async () => {
    const token = await login();
    const q = await quote(token);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => book(token, q)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results.filter((r) => r.error?.code === "SLOT_UNAVAILABLE"),
    ).toHaveLength(19);
    expect(
      Number(
        (await one<{ n: string }>(
          pool,
          "SELECT count(*) n FROM bookings WHERE start_at=$1",
          [tomorrow()],
        ))!.n,
      ),
    ).toBe(1);
  });
  it("returns the same result for a concurrent repeated idempotency key and rejects changed body", async () => {
    const token = await login();
    const q = await quote(token),
      key = randomUUID();
    const [a, b] = await Promise.all([
      book(token, q, "a", {}, key),
      book(token, q, "a", {}, key),
    ]);
    expect(a.data.id).toBe(b.data.id);
    const changed = await book(token, q, "a", { confirmOverlap: true }, key);
    expect(changed.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
  it("warns about another salon, then accepts only the bound challenge", async () => {
    const token = await login();
    await book(token, await quote(token));
    const q = await quote(token, "b");
    const warn = await book(token, q, "b");
    expect(warn.error.code).toBe("CLIENT_OVERLAP_CONFIRMATION_REQUIRED");
    expect(
      (
        await book(token, q, "b", {
          confirmOverlap: true,
          overlapChallengeToken: "fake",
        })
      ).status,
    ).toBe(409);
    const success = await book(token, q, "b", {
      confirmOverlap: true,
      overlapChallengeToken: warn.error.details.overlapChallengeToken,
    });
    expect(success.status).toBe(201);
  });
  it("keeps original booking if the target slot is taken after obtaining a reschedule quote", async () => {
    const token = await login(),
      other = await login("900010");
    const original = await book(token, await quote(token));
    const q = await req<{ id: string }>(
      "POST",
      `/api/v1/me/bookings/${original.data.id}/reschedule-quotes`,
      token,
      {
        serviceId: f("service-a-0"),
        staffId: f("staff-a-0"),
        startAt: tomorrow(11),
        expectedVersion: 1,
      },
    );
    await book(other, await quote(other, "a", 11));
    const moved = await req(
      "POST",
      `/api/v1/me/bookings/${original.data.id}/reschedule`,
      token,
      {
        quoteId: q.data.id,
        expectedVersion: 1,
        confirmedTermsVersion: "booking-p0-v1",
      },
    );
    expect(moved.error.code).toBe("SLOT_UNAVAILABLE");
    const saved = (await one<{ start_at: Date; version: number }>(
      pool,
      "SELECT start_at,version FROM bookings WHERE id=$1",
      [original.data.id],
    ))!;
    expect(saved.start_at.toISOString()).toBe(tomorrow());
    expect(saved.version).toBe(1);
  });
  it("does not leak foreign CRM and removes money from master DTO", async () => {
    const master = await login("master"),
      owner = await login("owner-a");
    const foreign = await req(
      "GET",
      `/api/v1/work/${f("salon-a")}/customers/${f("customer-b")}`,
      owner,
    );
    expect(foreign.status).toBe(404);
    expect(
      (await req("GET", `/api/v1/work/${f("salon-a")}/customers`, master))
        .status,
    ).toBe(403);
    const assigned = await req(
      "GET",
      `/api/v1/work/${f("salon-a")}/bookings/${f("booking-a-3")}`,
      master,
    );
    expect(assigned.status).toBe(200);
    expect(assigned.data).not.toHaveProperty("priceMinorSnapshot");
    expect(assigned.data).not.toHaveProperty("customerId");
    expect(
      (
        await req(
          "POST",
          `/api/v1/work/${f("salon-a")}/bookings/${f("booking-a-3")}/cancel`,
          master,
          { expectedVersion: 1, reason: "Test" },
        )
      ).status,
    ).toBe(403);
  });
  it("refuses stale versions and future completion; cancellation suppresses reminders", async () => {
    const client = await login(),
      owner = await login("owner-a");
    const b = await book(client, await quote(client));
    expect(
      (
        await req(
          "POST",
          `/api/v1/work/${f("salon-a")}/bookings/${b.data.id}/complete`,
          owner,
          { expectedVersion: 1 },
        )
      ).error.code,
    ).toBe("INVALID_STATE_TRANSITION");
    expect(
      (
        await req("POST", `/api/v1/me/bookings/${b.data.id}/cancel`, client, {
          expectedVersion: 2,
        })
      ).error.code,
    ).toBe("STALE_VERSION");
    expect(
      (
        await req("POST", `/api/v1/me/bookings/${b.data.id}/cancel`, client, {
          expectedVersion: 1,
        })
      ).status,
    ).toBe(201);
    const pending = await rows(
      pool,
      "SELECT id FROM deliveries WHERE booking_id=$1 AND category='reminder' AND state='scheduled'",
      [b.data.id],
    );
    expect(pending).toHaveLength(0);
  });
  it("requires both confirmations before linking manual history", async () => {
    const owner = await login("owner-a"),
      client = await login("900020");
    const inv = await req<{ token: string; id: string }>(
      "POST",
      `/api/v1/work/${f("salon-a")}/customers/${f("manual-a")}/link-invites`,
      owner,
      {},
    );
    expect(
      (
        await req("POST", "/api/v1/invites/accept", client, {
          token: inv.data.token,
          explicitConfirmation: true,
        })
      ).status,
    ).toBe(201);
    expect(
      (await one<{ user_id: string | null }>(
        pool,
        "SELECT user_id FROM customers WHERE id=$1",
        [f("manual-a")],
      ))!.user_id,
    ).toBeNull();
    expect(
      (
        await req(
          "POST",
          `/api/v1/work/${f("salon-a")}/customer-link-invites/${inv.data.id}/confirm`,
          owner,
          { expectedVersion: 2 },
        )
      ).status,
    ).toBe(201);
    expect(
      (await one<{ user_id: string | null }>(
        pool,
        "SELECT user_id FROM customers WHERE id=$1",
        [f("manual-a")],
      ))!.user_id,
    ).not.toBeNull();
  });
  it("revokes access even for a saved idempotent response", async () => {
    const owner = await login("owner-a"),
      admin = await login("admin");
    const key = randomUUID(),
      path = `/api/v1/work/${f("salon-a")}/customers`,
      body = { displayName: "Сотрудник создал" };
    expect((await req("POST", path, admin, body, key)).status).toBe(201);
    await req(
      "POST",
      `/api/v1/work/${f("salon-a")}/memberships/${f("membership-admin")}/revoke`,
      owner,
      { expectedVersion: 1, reason: "Тестовый отзыв" },
    );
    expect((await req("POST", path, admin, body, key)).status).toBe(404);
  });
  it("pauses new bookings without preventing existing cancellation", async () => {
    const client = await login(),
      owner = await login("owner-a");
    const b = await book(client, await quote(client));
    await req("POST", `/api/v1/work/${f("salon-a")}/pause`, owner, {
      expectedVersion: 1,
    });
    expect(
      (
        await req(
          "POST",
          `/api/v1/salons/${f("salon-a")}/booking-quotes`,
          client,
          {
            serviceId: f("service-a-0"),
            staffId: f("staff-a-0"),
            startAt: tomorrow(11),
          },
        )
      ).error.code,
    ).toBe("TENANT_UNAVAILABLE");
    expect(
      (
        await req("POST", `/api/v1/work/${f("salon-a")}/archive`, owner, {
          expectedVersion: 2,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await req("POST", `/api/v1/me/bookings/${b.data.id}/cancel`, client, {
          expectedVersion: 1,
        })
      ).status,
    ).toBe(201);
  });
  it("keeps original price after catalogue edits and during a same-service transfer", async () => {
    const client = await login(),
      owner = await login("owner-a");
    const b = await book(client, await quote(client));
    await req(
      "PATCH",
      `/api/v1/work/${f("salon-a")}/services/${f("service-a-0")}`,
      owner,
      {
        expectedVersion: 1,
        name: "Стрижка новая",
        durationMin: 90,
        priceMinor: 900000,
      },
    );
    const q = await req<{ priceMinor: number; durationMin: number }>(
      "POST",
      `/api/v1/me/bookings/${b.data.id}/reschedule-quotes`,
      client,
      {
        serviceId: f("service-a-0"),
        staffId: f("staff-a-0"),
        startAt: tomorrow(11),
        expectedVersion: 1,
      },
    );
    expect(q.data.priceMinor).toBe(250000);
    expect(q.data.durationMin).toBe(60);
  });
  it("excludes break-crossing slots and closed day exceptions", async () => {
    const day = DateTime.now()
      .setZone("Europe/Moscow")
      .plus({ days: 1 })
      .toISODate();
    const r = await req<{ items: { startAt: string }[] }>(
      "GET",
      `/api/v1/public/salons/line/slots?serviceId=${f("service-a-0")}&staffId=${f("staff-a-0")}&from=${day}`,
    );
    expect(r.status).toBe(200);
    const times = r.data.items.map((s) =>
      DateTime.fromISO(s.startAt).setZone("Europe/Moscow").toFormat("HH:mm"),
    );
    expect(times).not.toContain("12:15");
    expect(times).toContain("12:00");
    expect(times).toContain("14:00");
  });
});
describe("loyalty: paid visits earn an additional free visit", () => {
  async function setup() {
    const client = await login(),
      owner = await login("owner-a");
    const settings = await req(
      "PUT",
      `/api/v1/work/${f("salon-a")}/loyalty-programs`,
      owner,
      {
        serviceId: f("service-a-0"),
        visitsRequired: 2,
        enabled: true,
        expectedVersion: 1,
      },
    );
    expect(settings.status, JSON.stringify(settings.error)).toBe(200);
    return { client, owner };
  }
  async function finish(owner: string, id: string, expectedVersion = 1) {
    // Test fixture only: production never changes the server clock or visit time for rewards.
    const past = (await one<{ past: Date }>(
      pool,
      "SELECT min(start_at)-interval '2 hours' AS past FROM bookings WHERE staff_id=$1",
      [f("staff-a-0")],
    ))!.past;
    await pool.query(
      "UPDATE bookings SET start_at=$2,end_at=$2::timestamptz+interval '1 hour' WHERE id=$1",
      [id, past],
    );
    return req(
      "POST",
      `/api/v1/work/${f("salon-a")}/bookings/${id}/complete`,
      owner,
      { expectedVersion },
    );
  }
  async function earn(s: Awaited<ReturnType<typeof setup>>) {
    expect(
      (
        await req(
          "POST",
          `/api/v1/work/${f("salon-a")}/bookings/${f("booking-a-3")}/complete`,
          s.owner,
          { expectedVersion: 1 },
        )
      ).status,
    ).toBe(201);
    const b = await book(s.client, await quote(s.client));
    expect(b.status).toBe(201);
    expect((await finish(s.owner, b.data.id)).status).toBe(201);
    const rewards = await req<{ items: { id: string; status: string }[] }>(
      "GET",
      "/api/v1/me/loyalty-rewards",
      s.client,
    );
    expect(rewards.data.items).toHaveLength(1);
    return { reward: rewards.data.items[0]!, source: b.data.id };
  }
  it("issues exactly at the threshold, starts the next cycle, and excludes old history", async () => {
    const s = await setup();
    expect(
      (
        await req<{ items: unknown[] }>(
          "GET",
          "/api/v1/me/loyalty-rewards",
          s.client,
        )
      ).data.items,
    ).toHaveLength(0);
    await earn(s);
    const cards = await req<{
      items: {
        serviceId: string;
        progress: number;
        availableRewards: number;
      }[];
    }>("GET", "/api/v1/me/loyalty", s.client);
    expect(
      cards.data.items.find((p) => p.serviceId === f("service-a-0")),
    ).toMatchObject({ progress: 0, availableRewards: 1 });
    const next = await book(s.client, await quote(s.client));
    expect((await finish(s.owner, next.data.id)).status).toBe(201);
    expect(
      (await one<{ n: number }>(
        pool,
        "SELECT count(*)::int n FROM loyalty_rewards",
      ))!.n,
    ).toBe(1);
    expect(
      (await one<{ n: number }>(
        pool,
        "SELECT count(*)::int n FROM loyalty_stamps WHERE active AND reward_id IS NULL",
      ))!.n,
    ).toBe(1);
  });
  it("cannot earn twice from concurrent completion requests", async () => {
    const s = await setup();
    const result = await Promise.all(
      Array.from({ length: 20 }, () =>
        req(
          "POST",
          `/api/v1/work/${f("salon-a")}/bookings/${f("booking-a-3")}/complete`,
          s.owner,
          { expectedVersion: 1 },
        ),
      ),
    );
    expect(result.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      (await one<{ n: number }>(
        pool,
        "SELECT count(*)::int n FROM loyalty_stamps",
      ))!.n,
    ).toBe(1);
  });
  it("reserves once even for different slots, preserves zero price on transfer, releases and redeems", async () => {
    const s = await setup();
    const { reward } = await earn(s);
    const q1 = await quote(s.client, "a", 10, { loyaltyRewardId: reward.id }),
      q2 = await quote(s.client, "a", 11, { loyaltyRewardId: reward.id });
    const results = await Promise.all([book(s.client, q1), book(s.client, q2)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const b = results.find((r) => r.status === 201)!.data;
    expect(b.discountMinor).toBe(250000);
    const path = `/api/v1/me/bookings/${b.id}`;
    const movedQuote = await req<{ id: string; totalMinor: number }>(
      "POST",
      `${path}/reschedule-quotes`,
      s.client,
      {
        serviceId: f("service-a-0"),
        staffId: f("staff-a-0"),
        startAt: tomorrow(15),
        expectedVersion: 1,
      },
    );
    expect(movedQuote.status).toBe(201);
    expect(movedQuote.data.totalMinor).toBe(0);
    expect(
      (
        await req("POST", `${path}/reschedule`, s.client, {
          quoteId: movedQuote.data.id,
          expectedVersion: 1,
          confirmedTermsVersion: "booking-p0-v1",
        })
      ).status,
    ).toBe(201);
    expect(
      (await req("POST", `${path}/cancel`, s.client, { expectedVersion: 2 }))
        .status,
    ).toBe(201);
    expect(
      (await one<{ status: string }>(
        pool,
        "SELECT status FROM loyalty_rewards WHERE id=$1",
        [reward.id],
      ))!.status,
    ).toBe("issued");
    const free = await book(
      s.client,
      await quote(s.client, "a", 10, { loyaltyRewardId: reward.id }),
    );
    expect((await finish(s.owner, free.data.id)).status).toBe(201);
    expect(
      (await one<{ status: string }>(
        pool,
        "SELECT status FROM loyalty_rewards WHERE id=$1",
        [reward.id],
      ))!.status,
    ).toBe("redeemed");
    expect(
      (await one<{ n: number }>(
        pool,
        "SELECT count(*)::int n FROM loyalty_stamps",
      ))!.n,
    ).toBe(2);
  });
  it("rejects another customer, salon, service, and stacking with a partner voucher", async () => {
    const s = await setup(),
      { reward } = await earn(s),
      other = await login("900030");
    for (const [token, salon, service, extra] of [
      [other, "a", "service-a-0", {}],
      [s.client, "b", "service-b-0", {}],
      [s.client, "a", "service-a-1", {}],
      [s.client, "a", "service-a-0", { voucherId: randomUUID() }],
    ] as [string, string, string, Record<string, unknown>][]) {
      const r = await req(
        "POST",
        `/api/v1/salons/${f(`salon-${salon}`)}/booking-quotes`,
        token,
        {
          serviceId: f(service),
          staffId: f(`staff-${salon}-0`),
          startAt: tomorrow(),
          loyaltyRewardId: reward.id,
          ...extra,
        },
      );
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    expect(
      (
        await req<{ items: unknown[] }>(
          "GET",
          "/api/v1/me/loyalty-rewards",
          other,
        )
      ).data.items,
    ).toHaveLength(0);
    expect(
      (
        await req(
          "GET",
          `/api/v1/work/${f("salon-b")}/customers/${f("customer-a")}/loyalty`,
          await login("owner-b"),
        )
      ).status,
    ).toBe(404);
  });
  it("revokes an unused reward on correction and keeps other valid stamps", async () => {
    const s = await setup(),
      { reward, source } = await earn(s);
    expect(
      (
        await req(
          "POST",
          `/api/v1/work/${f("salon-a")}/bookings/${source}/correct-outcome`,
          s.owner,
          {
            expectedVersion: 2,
            targetStatus: "no_show",
            reason: "Ошибочная отметка",
          },
        )
      ).status,
    ).toBe(201);
    expect(
      (await one<{ status: string }>(
        pool,
        "SELECT status FROM loyalty_rewards WHERE id=$1",
        [reward.id],
      ))!.status,
    ).toBe("revoked");
    expect(
      (await one<{ n: number }>(
        pool,
        "SELECT count(*)::int n FROM loyalty_stamps WHERE active AND reward_id IS NULL",
      ))!.n,
    ).toBe(1);
  });
  it("blocks corrections that would invalidate reserved or consumed rewards", async () => {
    const s = await setup(),
      { reward, source } = await earn(s);
    const b = await book(
      s.client,
      await quote(s.client, "a", 10, { loyaltyRewardId: reward.id }),
    );
    const correction = () =>
      req(
        "POST",
        `/api/v1/work/${f("salon-a")}/bookings/${source}/correct-outcome`,
        s.owner,
        {
          expectedVersion: 2,
          targetStatus: "no_show",
          reason: "Ошибочная отметка",
        },
      );
    expect((await correction()).error.code).toBe("LOYALTY_REVIEW_REQUIRED");
    await finish(s.owner, b.data.id);
    expect((await correction()).error.code).toBe("LOYALTY_REVIEW_REQUIRED");
    expect(
      (await one<{ status: string }>(
        pool,
        "SELECT status FROM bookings WHERE id=$1",
        [source],
      ))!.status,
    ).toBe("completed");
  });
  it("pauses new accrual, preserves rewards, locks earned terms and restricts settings to owner", async () => {
    const s = await setup(),
      { reward } = await earn(s),
      path = `/api/v1/work/${f("salon-a")}/loyalty-programs`;
    const body = {
      serviceId: f("service-a-0"),
      visitsRequired: 2,
      enabled: false,
      expectedVersion: 2,
    };
    expect((await req("PUT", path, await login("admin"), body)).status).toBe(
      403,
    );
    expect(
      (await req("PUT", path, s.owner, { ...body, visitsRequired: 3 })).error
        .code,
    ).toBe("LOYALTY_TERMS_LOCKED");
    expect((await req("PUT", path, s.owner, body)).status).toBe(200);
    const b = await book(s.client, await quote(s.client));
    await finish(s.owner, b.data.id);
    expect(
      (await one<{ n: number }>(
        pool,
        "SELECT count(*)::int n FROM loyalty_stamps",
      ))!.n,
    ).toBe(2);
    expect(
      (
        await book(
          s.client,
          await quote(s.client, "a", 10, { loyaltyRewardId: reward.id }),
        )
      ).status,
    ).toBe(201);
  });
  it("excludes no-shows, cancellations and zero-price services", async () => {
    const s = await setup();
    expect(
      (
        await req(
          "POST",
          `/api/v1/work/${f("salon-a")}/bookings/${f("booking-a-3")}/no-show`,
          s.owner,
          { expectedVersion: 1 },
        )
      ).status,
    ).toBe(201);
    const b = await book(s.client, await quote(s.client));
    await req("POST", `/api/v1/me/bookings/${b.data.id}/cancel`, s.client, {
      expectedVersion: 1,
    });
    await pool.query("UPDATE services SET price_minor=0 WHERE id=$1", [
      f("service-a-0"),
    ]);
    const zero = await book(s.client, await quote(s.client));
    expect((await finish(s.owner, zero.data.id)).status).toBe(201);
    expect(await rows(pool, "SELECT * FROM loyalty_stamps")).toHaveLength(0);
  });
  it("returns a reward on no-show and refuses correction after another booking reserves it", async () => {
    const s = await setup(),
      { reward } = await earn(s);
    const free = await book(
      s.client,
      await quote(s.client, "a", 10, { loyaltyRewardId: reward.id }),
    );
    await pool.query(
      "UPDATE bookings SET start_at=now()-interval '2 hours',end_at=now()-interval '1 hour' WHERE id=$1",
      [free.data.id],
    );
    const path = `/api/v1/work/${f("salon-a")}/bookings/${free.data.id}`;
    expect(
      (await req("POST", `${path}/no-show`, s.owner, { expectedVersion: 1 }))
        .status,
    ).toBe(201);
    expect(
      (await one<{ status: string }>(
        pool,
        "SELECT status FROM loyalty_rewards WHERE id=$1",
        [reward.id],
      ))!.status,
    ).toBe("issued");
    expect(
      (
        await book(
          s.client,
          await quote(s.client, "a", 10, { loyaltyRewardId: reward.id }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await req("POST", `${path}/correct-outcome`, s.owner, {
          expectedVersion: 2,
          targetStatus: "completed",
          reason: "Исправить исход",
        })
      ).error.code,
    ).toBe("LOYALTY_REWARD_UNAVAILABLE");
  });
  it("keeps manual customer rewards when their MAX account is confirmed", async () => {
    const s = await setup(),
      newClient = await login("900041"),
      customerId = f("manual-a");
    for (let n = 0; n < 2; n++) {
      const q = await req<{ id: string }>(
        "POST",
        `/api/v1/work/${f("salon-a")}/booking-quotes`,
        s.owner,
        {
          serviceId: f("service-a-0"),
          staffId: f("staff-a-0"),
          startAt: tomorrow(),
          customerId,
        },
      );
      const b = await req<{ id: string }>(
        "POST",
        `/api/v1/work/${f("salon-a")}/bookings`,
        s.owner,
        { quoteId: q.data.id, confirmedTermsVersion: "booking-p0-v1" },
      );
      expect((await finish(s.owner, b.data.id)).status).toBe(201);
    }
    const inv = await req<{ id: string; token: string }>(
      "POST",
      `/api/v1/work/${f("salon-a")}/customers/${customerId}/link-invites`,
      s.owner,
      {},
    );
    expect(
      (
        await req("POST", "/api/v1/invites/accept", newClient, {
          token: inv.data.token,
          explicitConfirmation: true,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await req(
          "POST",
          `/api/v1/work/${f("salon-a")}/customer-link-invites/${inv.data.id}/confirm`,
          s.owner,
          { expectedVersion: 2 },
        )
      ).status,
    ).toBe(201);
    const rewards = await req<{ items: { id: string }[] }>(
      "GET",
      "/api/v1/me/loyalty-rewards",
      newClient,
    );
    expect(rewards.data.items).toHaveLength(1);
    expect(
      (
        await book(
          newClient,
          await quote(newClient, "a", 10, {
            loyaltyRewardId: rewards.data.items[0]!.id,
          }),
        )
      ).status,
    ).toBe(201);
  });
});

describe("post-visit master reviews", () => {
  const completed = f("booking-a-0");

  async function completedBooking(maxId: string, daysAgo: number) {
    const token = await login(maxId);
    const user = (await one<{ id: string }>(
      pool,
      "SELECT id FROM users WHERE max_user_id=$1",
      [maxId],
    ))!;
    const customerId = randomUUID();
    const bookingId = randomUUID();
    const start = DateTime.now()
      .setZone("Europe/Moscow")
      .minus({ days: daysAgo })
      .set({ hour: 16, minute: 0, second: 0, millisecond: 0 });
    await pool.query(
      "INSERT INTO customers(id,tenant_id,user_id,display_name) VALUES($1,$2,$3,$4)",
      [customerId, f("salon-a"), user.id, `Клиент ${maxId}`],
    );
    await pool.query(
      `INSERT INTO bookings(
         id,tenant_id,customer_id,user_id,staff_id,service_id,start_at,end_at,
         timezone_snapshot,status,source,service_name_snapshot,duration_snapshot,
         price_minor_snapshot,created_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'Europe/Moscow','completed','self',$9,60,250000,$4)`,
      [
        bookingId,
        f("salon-a"),
        customerId,
        user.id,
        f("staff-a-0"),
        f("service-a-0"),
        start.toJSDate(),
        start.plus({ hours: 1 }).toJSDate(),
        "Стрижка и укладка",
      ],
    );
    return { token, userId: user.id, customerId, bookingId };
  }

  it("creates, reads and updates one owned completed review idempotently", async () => {
    const client = await login();
    const key = randomUUID();
    const created = await req<{
      id: string;
      rating: number;
      version: number;
      staffNameSnapshot: string;
    }>("POST", `/api/v1/me/bookings/${completed}/review`, client, { rating: 5 }, key);
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    expect(created.data).toMatchObject({
      rating: 5,
      version: 1,
      staffNameSnapshot: "София",
    });
    expect(
      await req("POST", `/api/v1/me/bookings/${completed}/review`, client, { rating: 5 }, key),
    ).toMatchObject({ status: 201, data: { id: created.data.id, version: 1 } });
    expect(
      (
        await req(
          "POST",
          `/api/v1/me/bookings/${completed}/review`,
          client,
          { rating: 4 },
          key,
        )
      ).error.code,
    ).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(
      (
        await req("POST", `/api/v1/me/bookings/${completed}/review`, client, {
          rating: 5,
        })
      ).error.code,
    ).toBe("REVIEW_ALREADY_EXISTS");

    const detail = await req<{
      review: { rating: number; status: string; version: number };
      reviewEligibility: { eligible: boolean };
    }>("GET", `/api/v1/me/bookings/${completed}`, client);
    expect(detail.data).toMatchObject({
      review: { rating: 5, status: "active", version: 1 },
      reviewEligibility: { eligible: true },
    });
    const updateKey = randomUUID();
    const updated = await req<{ rating: number; version: number }>(
      "PATCH",
      `/api/v1/me/bookings/${completed}/review`,
      client,
      { rating: 4, expectedVersion: 1 },
      updateKey,
    );
    expect(updated).toMatchObject({ status: 200, data: { rating: 4, version: 2 } });
    expect(
      await req(
        "PATCH",
        `/api/v1/me/bookings/${completed}/review`,
        client,
        { rating: 4, expectedVersion: 1 },
        updateKey,
      ),
    ).toMatchObject({ status: 200, data: { rating: 4, version: 2 } });
    expect(
      (
        await req(
          "PATCH",
          `/api/v1/me/bookings/${completed}/review`,
          client,
          { rating: 3, expectedVersion: 1 },
          updateKey,
        )
      ).error.code,
    ).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(
      (
        await req("PATCH", `/api/v1/me/bookings/${completed}/review`, client, {
          rating: 3,
          expectedVersion: 1,
        })
      ).error.code,
    ).toBe("VERSION_CONFLICT");
    for (const rating of [0, 6, 2.5, "5"])
      expect(
        (
          await req("POST", `/api/v1/me/bookings/${f("booking-a-1")}/review`, client, {
            rating,
          })
        ).status,
      ).toBe(422);
    const stranger = await login("900041");
    expect(
      (await req("POST", `/api/v1/me/bookings/${completed}/review`, stranger, { rating: 1 }))
        .status,
    ).toBe(404);
    for (const booking of ["booking-a-1", "booking-a-2", "booking-a-3"])
      expect(
        (
          await req("POST", `/api/v1/me/bookings/${f(booking)}/review`, client, {
            rating: 5,
          })
        ).error.code,
      ).toBe("BOOKING_NOT_COMPLETED");
    expect(
      (await req("DELETE", `/api/v1/me/bookings/${completed}/review`, client, {})).status,
    ).toBe(404);
    const stoppedBotBooking = await completedBooking("900042", 20);
    await pool.query("UPDATE bot_channels SET state='stopped' WHERE user_id=$1", [
      stoppedBotBooking.userId,
    ]);
    const deliveryCountBefore = Number(
      (await one<{ n: string }>(pool, "SELECT count(*)::text n FROM deliveries"))!.n,
    );
    expect(
      (
        await req(
          "POST",
          `/api/v1/me/bookings/${stoppedBotBooking.bookingId}/review`,
          stoppedBotBooking.token,
          { rating: 5 },
        )
      ).status,
    ).toBe(201);
    expect(Number((await one<{ n: string }>(pool, "SELECT count(*)::text n FROM deliveries"))!.n)).toBe(
      deliveryCountBefore,
    );
  });

  it("allows exactly one of twenty concurrent first reviews", async () => {
    const pairBooking = await completedBooking("900047", 23);
    const pair = await Promise.all(
      Array.from({ length: 2 }, () =>
        req("POST", `/api/v1/me/bookings/${pairBooking.bookingId}/review`, pairBooking.token, {
          rating: 4,
        }),
      ),
    );
    expect(pair.filter((result) => result.status === 201)).toHaveLength(1);
    expect(pair.filter((result) => result.error?.code === "REVIEW_ALREADY_EXISTS")).toHaveLength(1);

    const client = await login();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        req("POST", `/api/v1/me/bookings/${completed}/review`, client, {
          rating: 5,
        }),
      ),
    );
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => result.error?.code === "REVIEW_ALREADY_EXISTS")).toHaveLength(19);
    expect(
      Number(
        (
          await one<{ n: string }>(
            pool,
            "SELECT count(*)::text n FROM visit_reviews WHERE booking_id=$1",
            [completed],
          )
        )!.n,
      ),
    ).toBe(1);
  });

  it("applies exactly one of two concurrent edits at the same version", async () => {
    const client = await login();
    await req("POST", `/api/v1/me/bookings/${completed}/review`, client, {
      rating: 5,
    });
    const attempts = await Promise.all([
      req("PATCH", `/api/v1/me/bookings/${completed}/review`, client, {
        rating: 4,
        expectedVersion: 1,
      }),
      req("PATCH", `/api/v1/me/bookings/${completed}/review`, client, {
        rating: 3,
        expectedVersion: 1,
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 200)).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.error?.code === "VERSION_CONFLICT")).toHaveLength(1);
    expect(
      (await one<{ version: number }>(pool, "SELECT version FROM visit_reviews WHERE booking_id=$1", [completed]))!
        .version,
    ).toBe(2);
  });

  it("serializes first review creation against an outcome correction", async () => {
    const client = await login();
    const owner = await login("owner-a");
    const [review, correction] = await Promise.all([
      req("POST", `/api/v1/me/bookings/${completed}/review`, client, {
        rating: 5,
      }),
      req(
        "POST",
        `/api/v1/work/${f("salon-a")}/bookings/${completed}/correct-outcome`,
        owner,
        {
          expectedVersion: 1,
          targetStatus: "no_show",
          reason: "Проверка гонки с отзывом",
        },
      ),
    ]);
    expect(correction.status, JSON.stringify(correction.error)).toBe(201);
    expect([201, 409]).toContain(review.status);
    expect(
      (await one<{ status: string }>(pool, "SELECT status FROM bookings WHERE id=$1", [completed]))!
        .status,
    ).toBe("no_show");
    const stored = await one<{ status: string }>(
      pool,
      "SELECT status FROM visit_reviews WHERE booking_id=$1",
      [completed],
    );
    expect(stored?.status ?? "absent").not.toBe("active");
  });

  it("publishes only a privacy-safe aggregate and keeps snapshots stable", async () => {
    const client = await login();
    expect(
      (
        await req("POST", `/api/v1/me/bookings/${completed}/review`, client, {
          rating: 5,
        })
      ).status,
    ).toBe(201);
    let publicCatalog = await req<{
      staff: Array<{ id: string; ratingAverage: number | null; ratingCount: number | null }>;
    }>("GET", "/api/v1/public/salons/line/catalog");
    expect(publicCatalog.data.staff.find((staff) => staff.id === f("staff-a-0"))).toMatchObject({
      ratingAverage: null,
      ratingCount: null,
    });
    const second = await completedBooking("900043", 21);
    const third = await completedBooking("900044", 22);
    await req("POST", `/api/v1/me/bookings/${second.bookingId}/review`, second.token, {
      rating: 4,
    });
    publicCatalog = await req("GET", "/api/v1/public/salons/line/catalog");
    expect(publicCatalog.data.staff.find((staff) => staff.id === f("staff-a-0"))).toMatchObject({
      ratingAverage: null,
      ratingCount: null,
    });
    await req("POST", `/api/v1/me/bookings/${third.bookingId}/review`, third.token, {
      rating: 3,
    });
    publicCatalog = await req("GET", "/api/v1/public/salons/line/catalog");
    expect(publicCatalog.data.staff.find((staff) => staff.id === f("staff-a-0"))).toMatchObject({
      ratingAverage: 4,
      ratingCount: 3,
    });
    const owner = await login("owner-a");
    const work = await req<{
      items: Array<{ id: string; ratingAverage: number; ratingCount: number }>;
    }>("GET", `/api/v1/work/${f("salon-a")}/staff`, owner);
    expect(work.data.items.find((staff) => staff.id === f("staff-a-0"))).toMatchObject({
      ratingAverage: 4,
      ratingCount: 3,
    });
    const master = await login("master");
    expect(
      (
        await req<{ ratingAverage: number; ratingCount: number }>(
          "GET",
          `/api/v1/work/${f("salon-a")}/my-staff-profile`,
          master,
        )
      ).data,
    ).toMatchObject({ ratingAverage: 4, ratingCount: 3 });
    expect(
      (await req("GET", `/api/v1/work/${f("salon-a")}/staff`, master)).status,
    ).toBe(403);
    await pool.query("UPDATE staff SET name='Новое имя' WHERE id=$1", [f("staff-a-0")]);
    await pool.query("UPDATE tenants SET name='Новое имя салона' WHERE id=$1", [f("salon-a")]);
    const detail = await req<{
      review: { staffNameSnapshot: string; tenantNameSnapshot: string };
    }>(
      "GET",
      `/api/v1/me/bookings/${completed}`,
      client,
    );
    expect(detail.data.review.staffNameSnapshot).toBe("София");
    expect(detail.data.review.tenantNameSnapshot).toBe("Линия · студия волос");

    const currentStaff = (await one<{ version: number }>(
      pool,
      "SELECT version FROM staff WHERE id=$1",
      [f("staff-a-0")],
    ))!;
    expect(
      (
        await req(
          "POST",
          `/api/v1/work/${f("salon-a")}/staff/${f("staff-a-0")}/archive`,
          owner,
          { expectedVersion: currentStaff.version },
        )
      ).status,
    ).toBe(201);
    publicCatalog = await req("GET", "/api/v1/public/salons/line/catalog");
    expect(publicCatalog.data.staff.some((staff: { id: string }) => staff.id === f("staff-a-0"))).toBe(
      false,
    );
    expect(
      Number(
        (
          await one<{ n: string }>(
            pool,
            "SELECT count(*)::text n FROM visit_reviews WHERE staff_id=$1 AND status='active'",
            [f("staff-a-0")],
          )
        )!.n,
      ),
    ).toBe(3);
    const archivedWork = await req<{
      items: Array<{ id: string; active: boolean; ratingAverage: number; ratingCount: number }>;
    }>("GET", `/api/v1/work/${f("salon-a")}/staff`, owner);
    expect(archivedWork.data.items.find((staff) => staff.id === f("staff-a-0"))).toMatchObject({
      active: false,
      ratingAverage: 4,
      ratingCount: 3,
    });
  });

  it("invalidates on outcome correction and requires explicit reactivation", async () => {
    const client = await login();
    const owner = await login("owner-a");
    await req("POST", `/api/v1/me/bookings/${completed}/review`, client, { rating: 5 });
    const corrected = await req(
      "POST",
      `/api/v1/work/${f("salon-a")}/bookings/${completed}/correct-outcome`,
      owner,
      {
        expectedVersion: 1,
        targetStatus: "no_show",
        reason: "Исправление тестового исхода",
      },
    );
    expect(corrected.status, JSON.stringify(corrected.error)).toBe(201);
    expect(
      (await one<{ status: string }>(pool, "SELECT status FROM visit_reviews WHERE booking_id=$1", [completed]))!
        .status,
    ).toBe("invalidated");
    const invalidatedAggregate = await req<{
      items: Array<{ id: string; ratingAverage: number | null; ratingCount: number }>;
    }>("GET", `/api/v1/work/${f("salon-a")}/staff`, owner);
    expect(invalidatedAggregate.data.items.find((staff) => staff.id === f("staff-a-0"))).toMatchObject({
      ratingAverage: null,
      ratingCount: 0,
    });
    expect(
      (
        await req("PATCH", `/api/v1/me/bookings/${completed}/review`, client, {
          rating: 4,
          expectedVersion: 2,
        })
      ).error.code,
    ).toBe("BOOKING_NOT_COMPLETED");
    expect(
      (
        await req(
          "POST",
          `/api/v1/work/${f("salon-a")}/bookings/${completed}/correct-outcome`,
          owner,
          {
            expectedVersion: 2,
            targetStatus: "completed",
            reason: "Визит подтверждён повторно",
          },
        )
      ).status,
    ).toBe(201);
    expect(
      (await one<{ status: string }>(pool, "SELECT status FROM visit_reviews WHERE booking_id=$1", [completed]))!
        .status,
    ).toBe("invalidated");
    const reactivated = await req<{ status: string; version: number; rating: number }>(
      "POST",
      `/api/v1/me/bookings/${completed}/review`,
      client,
      { rating: 4 },
    );
    expect(reactivated).toMatchObject({
      status: 201,
      data: { status: "active", version: 3, rating: 4 },
    });
    const reactivatedAggregate = await req<{
      items: Array<{ id: string; ratingAverage: number | null; ratingCount: number }>;
    }>("GET", `/api/v1/work/${f("salon-a")}/staff`, owner);
    expect(reactivatedAggregate.data.items.find((staff) => staff.id === f("staff-a-0"))).toMatchObject({
      ratingAverage: 4,
      ratingCount: 1,
    });
  });

  it("keeps unlinked manual visits private and enables them after confirmed linking", async () => {
    const client = await login("900045");
    const other = await login("900046");
    const user = (await one<{ id: string }>(pool, "SELECT id FROM users WHERE max_user_id='900045'"))!;
    const customerId = randomUUID();
    const bookingId = randomUUID();
    const start = DateTime.now().minus({ days: 40 });
    await pool.query(
      "INSERT INTO customers(id,tenant_id,display_name) VALUES($1,$2,'Ручной клиент')",
      [customerId, f("salon-a")],
    );
    await pool.query(
      `INSERT INTO bookings(
         id,tenant_id,customer_id,user_id,staff_id,service_id,start_at,end_at,
         timezone_snapshot,status,source,service_name_snapshot,duration_snapshot,
         price_minor_snapshot,created_by
       ) VALUES($1,$2,$3,NULL,$4,$5,$6,$7,'Europe/Moscow','completed','manual',$8,60,250000,$9)`,
      [
        bookingId,
        f("salon-a"),
        customerId,
        f("staff-a-0"),
        f("service-a-0"),
        start.toJSDate(),
        start.plus({ hours: 1 }).toJSDate(),
        "Стрижка и укладка",
        f("owner-a"),
      ],
    );
    expect(
      (await req("POST", `/api/v1/me/bookings/${bookingId}/review`, client, { rating: 5 })).status,
    ).toBe(404);
    await pool.query("UPDATE customers SET user_id=$2 WHERE id=$1", [customerId, user.id]);
    await pool.query("UPDATE bookings SET user_id=$2 WHERE customer_id=$1", [customerId, user.id]);
    expect(
      (await req("POST", `/api/v1/me/bookings/${bookingId}/review`, client, { rating: 5 })).status,
    ).toBe(201);
    expect(
      (await req("PATCH", `/api/v1/me/bookings/${bookingId}/review`, other, { rating: 1, expectedVersion: 1 })).status,
    ).toBe(404);
  });
});

describe("MAX durable channel lifecycle", () => {
  it("resolves notification links for clients, owners and assigned masters without cross-tenant access", async () => {
    const payload = `b_${f("booking-a-3")}`;
    for (const persona of ["client", "owner-a", "master"]) {
      const r = await req<{ path: string }>(
        "POST",
        "/api/v1/launch/resolve",
        await login(persona),
        { payload },
      );
      expect(r.status).toBe(200);
      expect(r.data.path).toBe(
        persona === "client"
          ? `/me/bookings/${f("booking-a-3")}`
          : `/work/${f("salon-a")}/bookings/${f("booking-a-3")}`,
      );
    }
    expect(
      (
        await req("POST", "/api/v1/launch/resolve", await login("owner-b"), {
          payload,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await req<{ path: string }>(
          "POST",
          "/api/v1/launch/resolve",
          await login(),
          { payload: "loyalty" },
        )
      ).data.path,
    ).toBe("/me/loyalty");
    expect(
      (
        await req<{ path: string }>(
          "POST",
          "/api/v1/launch/resolve",
          await login(),
          { payload: "home" },
        )
      ).data.path,
    ).toBe("/me/bookings");
  });
  it("requires webhook secret and persists before acknowledging", async () => {
    const denied = await app.inject({
      method: "POST",
      url: "/integrations/max/webhook",
      payload: {
        update_type: "bot_stopped",
        timestamp: 1,
        user: { user_id: 900001 },
      },
    });
    expect(denied.statusCode).toBe(403);
    const r = await app.inject({
      method: "POST",
      url: "/integrations/max/webhook",
      headers: { "x-max-bot-api-secret": "demo-webhook-secret" },
      payload: {
        update_type: "bot_stopped",
        timestamp: 2000,
        user: { user_id: "900001" },
      },
    });
    expect(r.statusCode).toBe(200);
    expect((await rows(pool, "SELECT * FROM max_inbox")).length).toBe(1);
    await processInbox();
    expect(
      (await one<{ state: string }>(
        pool,
        "SELECT state FROM bot_channels WHERE user_id=$1",
        [f("client")],
      ))!.state,
    ).toBe("stopped");
  });
  it("does not reactivate on delayed start or resurrect suppressed delivery", async () => {
    for (const [update_type, timestamp] of [
      ["bot_stopped", 5000],
      ["bot_started", 4000],
      ["dialog_removed", 5000],
      ["bot_started", 5000],
    ] as [string, number][]) {
      await app.inject({
        method: "POST",
        url: "/integrations/max/webhook",
        headers: { "x-max-bot-api-secret": "demo-webhook-secret" },
        payload: { update_type, timestamp, user: { user_id: "900001" } },
      });
      await processInbox();
    }
    expect(
      await one<{ state: string; generation: number }>(
        pool,
        "SELECT state,generation FROM bot_channels WHERE user_id=$1",
        [f("client")],
      ),
    ).toMatchObject({ state: "removed", generation: 3 });
  });
});

describe("partnership agreement and vouchers", () => {
  async function setup() {
    const client = await login(),
      a = await login("owner-a"),
      b = await login("owner-b");
    for (const [salon, token] of [
      ["a", a],
      ["b", b],
    ])
      expect(
        (
          await req(
            "PATCH",
            `/api/v1/work/${f(`salon-${salon}`)}/partner-settings`,
            token,
            { expectedVersion: 1, enabled: true },
          )
        ).status,
      ).toBe(200);
    await req("PATCH", "/api/v1/me/preferences", client, {
      expectedVersion: 1,
      partnerProgramEnabled: true,
      textVersion: "p0-v1",
    });
    await req(
      "PATCH",
      `/api/v1/me/salons/${f("salon-a")}/preferences`,
      client,
      {
        expectedVersion: 0,
        partnerAllowed: true,
        serviceBotEnabled: false,
        reminderBotEnabled: false,
        offerBotEnabled: false,
        textVersion: "p0-v1",
      },
    );
    const created = await req<{
      id: string;
      version: number;
      versions: { id: string; termsHash: string }[];
    }>("POST", `/api/v1/work/${f("salon-a")}/campaigns`, a, {
      sourceTenantId: f("salon-a"),
      targetTenantId: f("salon-b"),
      sourceServiceIds: [f("service-a-0")],
      targetServiceIds: [f("service-b-0")],
      discountMinor: 30000,
      issueFrom: new Date(Date.now() - 86400000).toISOString(),
      issueUntil: new Date(Date.now() + 86400000 * 10).toISOString(),
      voucherValidDays: 14,
      issueLimit: 1,
      termsText: "Тестовая скидка",
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    const c = created.data;
    const v = c.versions[0]!;
    expect(
      (
        await req(
          "POST",
          `/api/v1/work/${f("salon-a")}/campaigns/${c.id}/versions/${v.id}/propose`,
          a,
          { expectedVersion: 1 },
        )
      ).status,
    ).toBe(201);
    return { client, a, b, c, v };
  }
  async function accept(s: Awaited<ReturnType<typeof setup>>) {
    const accepted = await req(
      "POST",
      `/api/v1/work/${f("salon-b")}/campaigns/${s.c.id}/versions/${s.v.id}/accept`,
      s.b,
      {
        expectedVersion: 2,
        termsHash: s.v.termsHash,
        explicitConfirmation: true,
      },
    );
    expect(accepted.status, JSON.stringify(accepted.error)).toBe(201);
  }
  async function complete(s: Awaited<ReturnType<typeof setup>>) {
    const r = await req(
      "POST",
      `/api/v1/work/${f("salon-a")}/bookings/${f("booking-a-3")}/complete`,
      s.a,
      { expectedVersion: 1 },
    );
    expect(r.status, JSON.stringify(r.error)).toBe(201);
    return (await one<{ id: string; status: string; discount_minor: number }>(
      pool,
      "SELECT * FROM vouchers WHERE campaign_id=$1",
      [s.c.id],
    ))!;
  }
  it("does not issue before acceptance, and rejects accepting an altered hash", async () => {
    const s = await setup();
    const bad = await req(
      "POST",
      `/api/v1/work/${f("salon-b")}/campaigns/${s.c.id}/versions/${s.v.id}/accept`,
      s.b,
      { expectedVersion: 2, termsHash: "changed", explicitConfirmation: true },
    );
    expect(bad.error.code).toBe("STALE_VERSION");
    await req(
      "POST",
      `/api/v1/work/${f("salon-a")}/bookings/${f("booking-a-3")}/complete`,
      s.a,
      { expectedVersion: 1 },
    );
    expect(await rows(pool, "SELECT id FROM vouchers")).toHaveLength(0);
  });
  it("issues once, reserves once under 20-way race, releases on cancellation", async () => {
    const s = await setup();
    await accept(s);
    const voucher = await complete(s);
    expect(voucher.discount_minor).toBe(30000);
    const quoteIds = [];
    for (let n = 0; n < 20; n++)
      quoteIds.push(await quote(s.client, "b", 10, { voucherId: voucher.id }));
    const results = await Promise.all(
      quoteIds.map((q) => book(s.client, q, "b")),
    );
    const success = results.filter((r) => r.status === 201);
    expect(success).toHaveLength(1);
    expect(success[0]!.data.discountMinor).toBe(30000);
    expect(
      (await one<{ status: string }>(
        pool,
        "SELECT status FROM vouchers WHERE id=$1",
        [voucher.id],
      ))!.status,
    ).toBe("reserved");
    await req(
      "POST",
      `/api/v1/me/bookings/${success[0]!.data.id}/cancel`,
      s.client,
      { expectedVersion: 1 },
    );
    expect(
      (await one<{ status: string }>(
        pool,
        "SELECT status FROM vouchers WHERE id=$1",
        [voucher.id],
      ))!.status,
    ).toBe("issued");
    expect(
      (await one<{ issued_total: number }>(
        pool,
        "SELECT issued_total FROM campaigns WHERE id=$1",
        [s.c.id],
      ))!.issued_total,
    ).toBe(1);
  });
  it("redeems only when the bound visit is completed and never unredeems on correction", async () => {
    const s = await setup();
    await accept(s);
    const v = await complete(s);
    const booking = await book(
      s.client,
      await quote(s.client, "b", 10, { voucherId: v.id }),
      "b",
    );
    expect(booking.status).toBe(201);
    // Test-only fixture shifts this target appointment into the past to exercise completion without wall-clock sleeps.
    await pool.query(
      "UPDATE bookings SET start_at=now()-interval '2 hours',end_at=now()-interval '1 hour' WHERE id=$1",
      [booking.data.id],
    );
    const result = await req(
      "POST",
      `/api/v1/work/${f("salon-b")}/bookings/${booking.data.id}/complete`,
      s.b,
      { expectedVersion: 1 },
    );
    expect(result.status).toBe(201);
    expect(
      (await one<{ status: string }>(
        pool,
        "SELECT status FROM vouchers WHERE id=$1",
        [v.id],
      ))!.status,
    ).toBe("redeemed");
    await req(
      "POST",
      `/api/v1/work/${f("salon-b")}/bookings/${booking.data.id}/correct-outcome`,
      s.b,
      { expectedVersion: 2, targetStatus: "no_show", reason: "Ошибка отметки" },
    );
    expect(
      (await one<{ status: string }>(
        pool,
        "SELECT status FROM vouchers WHERE id=$1",
        [v.id],
      ))!.status,
    ).toBe("redeemed");
  });
  it("does not issue retrospectively when consent is enabled after completion", async () => {
    const s = await setup();
    await accept(s);
    await req("PATCH", "/api/v1/me/preferences", s.client, {
      expectedVersion: 2,
      partnerProgramEnabled: false,
      textVersion: "p0-v1",
    });
    await req(
      "POST",
      `/api/v1/work/${f("salon-a")}/bookings/${f("booking-a-3")}/complete`,
      s.a,
      { expectedVersion: 1 },
    );
    await req("PATCH", "/api/v1/me/preferences", s.client, {
      expectedVersion: 3,
      partnerProgramEnabled: true,
      textVersion: "p0-v1",
    });
    expect(await rows(pool, "SELECT id FROM vouchers")).toHaveLength(0);
  });
  it("keeps the reserved price until client explicitly approves revocation", async () => {
    const s = await setup();
    await accept(s);
    const v = await complete(s);
    const booking = await book(
      s.client,
      await quote(s.client, "b", 10, { voucherId: v.id }),
      "b",
    );
    const request = await req<{ id: string }>(
      "POST",
      `/api/v1/work/${f("salon-b")}/vouchers/${v.id}/revocation-requests`,
      s.b,
      { expectedVersion: 2, reason: "Тест согласования" },
    );
    expect(request.status).toBe(201);
    expect(
      (await one<{ discount_minor: number }>(
        pool,
        "SELECT discount_minor FROM bookings WHERE id=$1",
        [booking.data.id],
      ))!.discount_minor,
    ).toBe(30000);
    await req(
      "POST",
      `/api/v1/me/voucher-revocation-requests/${request.data.id}/respond`,
      s.client,
      { expectedVersion: 1, expectedBookingVersion: 1, accept: false },
    );
    expect(
      (await one<{ discount_minor: number }>(
        pool,
        "SELECT discount_minor FROM bookings WHERE id=$1",
        [booking.data.id],
      ))!.discount_minor,
    ).toBe(30000);
  });
  it("allows each side to remove only its own pause", async () => {
    const s = await setup();
    await accept(s);
    await req(
      "POST",
      `/api/v1/work/${f("salon-a")}/campaigns/${s.c.id}/pause`,
      s.a,
      { expectedVersion: 3, reason: "Пауза A" },
    );
    await req(
      "POST",
      `/api/v1/work/${f("salon-b")}/campaigns/${s.c.id}/pause`,
      s.b,
      { expectedVersion: 4, reason: "Пауза B" },
    );
    await req(
      "POST",
      `/api/v1/work/${f("salon-a")}/campaigns/${s.c.id}/resume`,
      s.a,
      { expectedVersion: 5 },
    );
    expect(
      await rows(
        pool,
        "SELECT tenant_id FROM campaign_pauses WHERE campaign_id=$1",
        [s.c.id],
      ),
    ).toEqual([{ tenant_id: f("salon-b") }]);
    await req(
      "POST",
      `/api/v1/work/${f("salon-a")}/bookings/${f("booking-a-3")}/complete`,
      s.a,
      { expectedVersion: 1 },
    );
    expect(await rows(pool, "SELECT id FROM vouchers")).toHaveLength(0);
  });
});

describe("session lifetime", () => {
  const sessionRow = (token: string) =>
    one<{ expires_at: Date; created_at: Date }>(
      pool,
      "SELECT expires_at,created_at FROM sessions WHERE token_hash=$1",
      [createHash("sha256").update(token).digest("hex")],
    );
  it("slides forward while the person keeps working", async () => {
    const token = await login("owner-a");
    await pool.query("UPDATE sessions SET expires_at=now()+interval '60 seconds'");
    expect((await req("GET", "/api/v1/me", token)).status).toBe(200);
    const after = (await sessionRow(token))!;
    // renewed to roughly the full idle window instead of dying mid-shift
    expect(after.expires_at.getTime() - Date.now()).toBeGreaterThan(
      config.SESSION_IDLE_SECONDS * 900,
    );
  });
  it("never slides past the absolute cap and leaves fresh sessions untouched", async () => {
    const token = await login("owner-a");
    const fresh = (await sessionRow(token))!.expires_at.getTime();
    expect((await req("GET", "/api/v1/me", token)).status).toBe(200);
    expect((await sessionRow(token))!.expires_at.getTime()).toBe(fresh);
    // half an hour of absolute budget left: renewal stops there, not at a full idle window
    await pool.query(
      `UPDATE sessions SET created_at=now()-make_interval(secs=>${config.SESSION_ABSOLUTE_SECONDS - 1800}), expires_at=now()+interval '60 seconds'`,
    );
    expect((await req("GET", "/api/v1/me", token)).status).toBe(200);
    const capped = (await sessionRow(token))!.expires_at.getTime() - Date.now();
    expect(capped).toBeGreaterThan(1500 * 1000);
    expect(capped).toBeLessThan(1900 * 1000);
  });
  it("rejects a session that reached the absolute cap", async () => {
    const token = await login("owner-a");
    await pool.query(
      `UPDATE sessions SET created_at=now()-make_interval(secs=>${config.SESSION_ABSOLUTE_SECONDS + 3600}), expires_at=now()-interval '1 second'`,
    );
    expect((await req("GET", "/api/v1/me", token)).status).toBe(401);
  });
});

describe("invite links", () => {
  it("inspects a staff invite instead of failing on an ambiguous column", async () => {
    const owner = await login("owner-a");
    const invite = await req<{ token: string }>(
      "POST",
      `/api/v1/work/${f("salon-a")}/staff-invites`,
      owner,
      { role: "admin" },
    );
    expect(invite.status, JSON.stringify(invite.error)).toBe(201);

    // Both invites and tenants have a status column, so the unqualified WHERE used to
    // raise 42702 and surface as a 503 on every invite link.
    const guest = await login("new");
    const seen = await req<{ kind: string; role: string; tenantName: string }>(
      "POST",
      "/api/v1/invites/inspect",
      guest,
      { token: invite.data.token },
    );
    expect(seen.status, JSON.stringify(seen.error)).toBe(200);
    expect(seen.data.kind).toBe("staff");
    expect(seen.data.role).toBe("admin");

    const accepted = await req("POST", "/api/v1/invites/accept", guest, {
      token: invite.data.token,
      explicitConfirmation: true,
    });
    expect(accepted.status, JSON.stringify(accepted.error)).toBe(201);
    expect(
      await one(
        pool,
        "SELECT id FROM memberships WHERE tenant_id=$1 AND role='admin' AND status='active'",
        [f("salon-a")],
      ),
    ).toBeTruthy();
  });
});

describe("Live Window Lite", () => {
  const date = () =>
    DateTime.now().setZone("Europe/Moscow").plus({ days: 1 }).toISODate()!;

  async function enable() {
    const owner = await login("owner-a");
    await pool.query(
      "INSERT INTO system_state(key,value) VALUES('live_window_allowlist','{\"enabled\":true}'),('live_window_kill_switch','{\"enabled\":false}') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
    );
    const result = await req(
      "PATCH",
      `/api/v1/work/${f("salon-a")}/live-window/settings`,
      owner,
      {
        expectedVersion: 0,
        enabled: true,
        paused: false,
        pauseReason: null,
        offerTtlMinutes: 10,
        minimumNoticeMinutes: 0,
        quietStart: "00:00",
        quietEnd: "23:59",
      },
    );
    expect(result.status, JSON.stringify(result.error)).toBe(200);
  }

  async function candidate(maxId: string) {
    const token = await login(maxId);
    const user = (await one<{ id: string }>(
      pool,
      "SELECT id FROM users WHERE max_user_id=$1",
      [maxId],
    ))!;
    await pool.query(
      "INSERT INTO bot_channels(user_id,state,generation) VALUES($1,'active',1) ON CONFLICT(user_id) DO UPDATE SET state='active',generation=bot_channels.generation+1",
      [user.id],
    );
    return { token, userId: user.id };
  }

  async function wait(
    token: string,
    linkedBookingId?: string,
    start = "10:00",
    end = "11:00",
  ) {
    return req<{ id: string; version: number }>(
      "POST",
      "/api/v1/me/waitlist-requests",
      token,
      {
        tenantId: f("salon-a"),
        serviceId: f("service-a-0"),
        staffIds: [f("staff-a-0")],
        ...(linkedBookingId ? { linkedBookingId } : {}),
        dateFrom: date(),
        dateTo: date(),
        weekdays: [DateTime.fromISO(date()).weekday],
        dailyStartLocal: start,
        dailyEndLocal: end,
        minimumNoticeMinutes: 0,
        consentVersion: "live-window-v1",
        consentSource: "mini_app",
      },
    );
  }

  async function waitWith(
    token: string,
    overrides: Record<string, unknown> = {},
  ) {
    return req<{ id: string; version: number }>(
      "POST",
      "/api/v1/me/waitlist-requests",
      token,
      {
        tenantId: f("salon-a"),
        serviceId: f("service-a-0"),
        staffIds: [f("staff-a-0")],
        dateFrom: date(),
        dateTo: date(),
        weekdays: [DateTime.fromISO(date()).weekday],
        dailyStartLocal: "10:00",
        dailyEndLocal: "11:00",
        minimumNoticeMinutes: 0,
        consentVersion: "live-window-v1",
        consentSource: "mini_app",
        ...overrides,
      },
    );
  }

  async function release(holder: string, bookingId: string) {
    const cancelled = await req(
      "POST",
      `/api/v1/me/bookings/${bookingId}/cancel`,
      holder,
      { expectedVersion: 1 },
    );
    expect(cancelled.status, JSON.stringify(cancelled.error)).toBe(201);
    await runLiveWindowCycle();
  }

  async function offerFor(userId: string) {
    const offer = (await one<{ id: string; version: number; request_id: string }>(
      pool,
      "SELECT id,version,request_id FROM live_window_offers WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
      [userId],
    ))!;
    await pool.query(
      "UPDATE live_window_offers SET status='offered',offered_at=now(),expires_at=now()+interval '10 minutes',version=version+1 WHERE id=$1",
      [offer.id],
    );
    return { ...offer, version: offer.version + 1 };
  }

  it("matches FIFO once, books atomically, and preserves accept idempotency", async () => {
    await enable();
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const first = await candidate("900010");
    const second = await candidate("900011");
    const r1 = await wait(first.token);
    const r2 = await wait(second.token);
    expect(r1.status, JSON.stringify(r1.error)).toBe(201);
    expect(r2.status, JSON.stringify(r2.error)).toBe(201);
    await pool.query(
      "UPDATE waitlist_requests SET priority_at=CASE id WHEN $1 THEN now()-interval '2 hours' ELSE now()-interval '1 hour' END WHERE id=ANY($2::uuid[])",
      [r1.data.id, [r1.data.id, r2.data.id]],
    );
    await release(holder, occupied.data.id);
    await runLiveWindowCycle();
    expect(
      Number(
        (await one<{ n: string }>(pool, "SELECT count(*)::text n FROM live_windows"))!.n,
      ),
    ).toBe(1);
    expect(
      Number(
        (await one<{ n: string }>(pool, "SELECT count(*)::text n FROM live_window_offers"))!.n,
      ),
    ).toBe(1);
    const offer = await offerFor(first.userId);
    expect(offer.request_id).toBe(r1.data.id);
    const key = randomUUID();
    const accepted = await req<{ status: string; booking: { id: string } }>(
      "POST",
      `/api/v1/me/live-window-offers/${offer.id}/accept`,
      first.token,
      { expectedVersion: offer.version, confirmedTermsVersion: "booking-p0-v1" },
      key,
    );
    expect(accepted.status, JSON.stringify(accepted.error)).toBe(201);
    expect(accepted.data.status).toBe("booked");
    const repeat = await req<{ status: string; booking: { id: string } }>(
      "POST",
      `/api/v1/me/live-window-offers/${offer.id}/accept`,
      first.token,
      { expectedVersion: offer.version, confirmedTermsVersion: "booking-p0-v1" },
      key,
    );
    expect(repeat.data.booking.id).toBe(accepted.data.booking.id);
    const changed = await req(
      "POST",
      `/api/v1/me/live-window-offers/${offer.id}/accept`,
      first.token,
      { expectedVersion: offer.version, confirmedTermsVersion: "booking-p0-v1", confirmOverlap: true },
      key,
    );
    expect(changed.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(
      Number(
        (
          await one<{ n: string }>(
            pool,
            "SELECT count(*)::text n FROM audit_log WHERE action='live_window.offer_booked' AND object_id=$1",
            [offer.id],
          )
        )!.n,
      ),
    ).toBe(1);
  });

  it("lets an ordinary booking win while an offer is open", async () => {
    await enable();
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const waiting = await candidate("900012");
    expect((await wait(waiting.token)).status).toBe(201);
    await release(holder, occupied.data.id);
    const offer = await offerFor(waiting.userId);
    const ordinary = await candidate("900013");
    expect((await book(ordinary.token, await quote(ordinary.token))).status).toBe(201);
    const lost = await req<{ status: string }>(
      "POST",
      `/api/v1/me/live-window-offers/${offer.id}/accept`,
      waiting.token,
      { expectedVersion: offer.version, confirmedTermsVersion: "booking-p0-v1" },
    );
    expect(lost.data.status).toBe("lost");
    expect(
      (await one<{ status: string }>(pool, "SELECT status FROM waitlist_requests WHERE id=$1", [offer.request_id]))!.status,
    ).toBe("active");
  });

  it("lets a manual work booking win while an offer is open", async () => {
    await enable();
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const waiting = await candidate("900037");
    expect((await wait(waiting.token)).status).toBe(201);
    await release(holder, occupied.data.id);
    const offer = await offerFor(waiting.userId);
    const owner = await login("owner-a");
    const manualQuote = await req<{ id: string }>(
      "POST",
      `/api/v1/work/${f("salon-a")}/booking-quotes`,
      owner,
      {
        serviceId: f("service-a-0"),
        staffId: f("staff-a-0"),
        customerId: f("manual-a"),
        startAt: tomorrow(10),
      },
    );
    expect(manualQuote.status, JSON.stringify(manualQuote.error)).toBe(201);
    const manual = await req(
      "POST",
      `/api/v1/work/${f("salon-a")}/bookings`,
      owner,
      {
        quoteId: manualQuote.data.id,
        confirmedTermsVersion: "booking-p0-v1",
      },
    );
    expect(manual.status, JSON.stringify(manual.error)).toBe(201);
    const lost = await req<{ status: string }>(
      "POST",
      `/api/v1/me/live-window-offers/${offer.id}/accept`,
      waiting.token,
      {
        expectedVersion: offer.version,
        confirmedTermsVersion: "booking-p0-v1",
      },
    );
    expect(lost.data.status).toBe("lost");
  });

  it("moves a linked booking without cascading its old slot", async () => {
    await enable();
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const waiting = await candidate("900014");
    const later = await book(waiting.token, await quote(waiting.token, "a", 12));
    const request = await wait(waiting.token, later.data.id);
    expect(request.status, JSON.stringify(request.error)).toBe(201);
    await release(holder, occupied.data.id);
    const offer = await offerFor(waiting.userId);
    const accepted = await req<{ status: string; booking: { id: string } }>(
      "POST",
      `/api/v1/me/live-window-offers/${offer.id}/accept`,
      waiting.token,
      { expectedVersion: offer.version, confirmedTermsVersion: "booking-p0-v1" },
    );
    expect(accepted.data.booking.id).toBe(later.data.id);
    await runLiveWindowCycle();
    expect(
      Number((await one<{ n: string }>(pool, "SELECT count(*)::text n FROM live_windows"))!.n),
    ).toBe(1);
    const event = await one<{ payload: { cascade: boolean } }>(
      pool,
      "SELECT payload FROM domain_outbox WHERE event_key LIKE $1 ORDER BY created_at DESC LIMIT 1",
      [`booking.slot_released:${later.data.id}:%`],
    );
    expect(event?.payload.cascade).toBe(false);
  });

  it("keeps requests and offers tenant scoped and denies the master queue", async () => {
    await enable();
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const waiting = await candidate("900015");
    const request = await wait(waiting.token);
    await release(holder, occupied.data.id);
    const offer = await offerFor(waiting.userId);
    const foreign = await candidate("900016");
    expect((await req("GET", `/api/v1/me/waitlist-requests/${request.data.id}`, foreign.token)).status).toBe(404);
    expect((await req("GET", `/api/v1/me/live-window-offers/${offer.id}`, foreign.token)).status).toBe(404);
    expect(
      (
        await req<{ path: string }>(
          "POST",
          "/api/v1/launch/resolve",
          waiting.token,
          { payload: `lw_${offer.id}` },
        )
      ).data.path,
    ).toBe(`/me/live-window/offers/${offer.id}`);
    expect(
      (
        await req(
          "POST",
          "/api/v1/launch/resolve",
          foreign.token,
          { payload: `lw_${offer.id}` },
        )
      ).status,
    ).toBe(404);
    const master = await login("master");
    expect((await req("GET", `/api/v1/work/${f("salon-a")}/live-window/windows`, master)).status).toBe(403);
  });

  it("serializes twenty competing accepts to one booking", async () => {
    await enable();
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const waiting = await candidate("900020");
    expect((await wait(waiting.token)).status).toBe(201);
    await release(holder, occupied.data.id);
    const offer = await offerFor(waiting.userId);
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        req<{ status: string; booking?: { id: string } }>(
          "POST",
          `/api/v1/me/live-window-offers/${offer.id}/accept`,
          waiting.token,
          {
            expectedVersion: offer.version,
            confirmedTermsVersion: "booking-p0-v1",
          },
          randomUUID(),
        ),
      ),
    );
    expect(attempts.filter((attempt) => attempt.data?.status === "booked")).toHaveLength(1);
    const filled = (await one<{ filled_booking_id: string }>(
      pool,
      "SELECT filled_booking_id FROM live_windows WHERE status='filled'",
    ))!;
    expect(filled.filled_booking_id).toBeTruthy();
    expect(
      Number(
        (
          await one<{ n: string }>(
            pool,
            "SELECT count(*)::text n FROM bookings WHERE id=$1",
            [filled.filled_booking_id],
          )
        )!.n,
      ),
    ).toBe(1);
  });

  it("recovers an expired outbox lease without duplicating a window or offer", async () => {
    await enable();
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const waiting = await candidate("900038");
    expect((await wait(waiting.token)).status).toBe(201);
    const cancelled = await req(
      "POST",
      `/api/v1/me/bookings/${occupied.data.id}/cancel`,
      holder,
      { expectedVersion: 1 },
    );
    expect(cancelled.status).toBe(201);
    await pool.query(
      "UPDATE domain_outbox SET state='processing',lease_until=now()-interval '1 second',fence=7 WHERE event_key LIKE $1",
      [`booking.slot_released:${occupied.data.id}:%`],
    );
    await Promise.all([runLiveWindowCycle(), runLiveWindowCycle()]);
    expect(
      Number(
        (await one<{ n: string }>(pool, "SELECT count(*)::text n FROM live_windows"))!
          .n,
      ),
    ).toBe(1);
    expect(
      Number(
        (
          await one<{ n: string }>(
            pool,
            "SELECT count(*)::text n FROM live_window_offers",
          )
        )!.n,
      ),
    ).toBe(1);
    expect(
      await one<{ state: string }>(
        pool,
        "SELECT state FROM domain_outbox WHERE event_key LIKE $1",
        [`booking.slot_released:${occupied.data.id}:%`],
      ),
    ).toMatchObject({ state: "processed" });
  });

  it("expires an offer and advances to the next FIFO candidate exactly once", async () => {
    await enable();
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const first = await candidate("900021");
    const second = await candidate("900022");
    const firstRequest = await wait(first.token);
    const secondRequest = await wait(second.token);
    await pool.query(
      "UPDATE waitlist_requests SET priority_at=CASE id WHEN $1 THEN now()-interval '2 hours' ELSE now()-interval '1 hour' END WHERE id=ANY($2::uuid[])",
      [firstRequest.data.id, [firstRequest.data.id, secondRequest.data.id]],
    );
    await release(holder, occupied.data.id);
    const delivery = (await one<{ id: string; live_window_offer_id: string }>(
      pool,
      "SELECT id,live_window_offer_id FROM deliveries WHERE live_window_offer_id IS NOT NULL",
    ))!;
    await pool.query("UPDATE deliveries SET due_at=now() WHERE id=$1", [
      delivery.id,
    ]);
    await redis.flushdb();
    await processDelivery(delivery.id);
    expect(
      await one<{ state: string; last_error: string | null }>(
        pool,
        "SELECT state,last_error FROM deliveries WHERE id=$1",
        [delivery.id],
      ),
    ).toMatchObject({ state: "retry_wait", last_error: "RATE_LIMITED" });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await pool.query("UPDATE deliveries SET due_at=now() WHERE id=$1", [
      delivery.id,
    ]);
    await processDelivery(delivery.id);
    expect(
      await one<{ state: string; last_error: string | null }>(
        pool,
        "SELECT state,last_error FROM deliveries WHERE id=$1",
        [delivery.id],
      ),
    ).toMatchObject({ state: "sent", last_error: null });
    const firstOffer = (await one<{
      id: string;
      status: string;
      expires_at: Date;
    }>(
      pool,
      "SELECT id,status,expires_at FROM live_window_offers WHERE id=$1",
      [delivery.live_window_offer_id],
    ))!;
    expect(firstOffer.status).toBe("offered");
    expect(firstOffer.expires_at.getTime()).toBeGreaterThan(Date.now());
    await pool.query(
      "UPDATE live_window_offers SET expires_at=now()-interval '1 second' WHERE id=$1",
      [firstOffer.id],
    );
    await runLiveWindowCycle();
    expect(
      await one<{ status: string }>(
        pool,
        "SELECT status FROM live_window_offers WHERE id=$1",
        [firstOffer.id],
      ),
    ).toMatchObject({ status: "expired" });
    expect(
      (
        await req<{ status: string }>(
          "GET",
          `/api/v1/me/live-window-offers/${firstOffer.id}`,
          first.token,
        )
      ).data.status,
    ).toBe("expired");
    const offers = await rows<{ request_id: string; sequence: number }>(
      pool,
      "SELECT request_id,sequence FROM live_window_offers ORDER BY sequence",
    );
    expect(offers).toEqual([
      { request_id: firstRequest.data.id, sequence: 1 },
      { request_id: secondRequest.data.id, sequence: 2 },
    ]);
  });

  it("advances to the next FIFO candidate after an explicit decline", async () => {
    await enable();
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const first = await candidate("900039");
    const second = await candidate("900040");
    const firstRequest = await wait(first.token);
    const secondRequest = await wait(second.token);
    await pool.query(
      "UPDATE waitlist_requests SET priority_at=CASE id WHEN $1 THEN now()-interval '2 hours' ELSE now()-interval '1 hour' END WHERE id=ANY($2::uuid[])",
      [firstRequest.data.id, [firstRequest.data.id, secondRequest.data.id]],
    );
    await release(holder, occupied.data.id);
    const offer = await offerFor(first.userId);
    const declined = await req(
      "POST",
      `/api/v1/me/live-window-offers/${offer.id}/decline`,
      first.token,
      { expectedVersion: offer.version, stopRequest: false },
    );
    expect(declined.status, JSON.stringify(declined.error)).toBe(201);
    expect(
      await one<{ request_id: string; sequence: number }>(
        pool,
        "SELECT request_id,sequence FROM live_window_offers WHERE status='pending_delivery' ORDER BY sequence DESC LIMIT 1",
      ),
    ).toMatchObject({ request_id: secondRequest.data.id, sequence: 2 });
  });

  it("does not offer a window inside the minimum-notice boundary", async () => {
    await enable();
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const waiting = await candidate("900041");
    const request = await waitWith(waiting.token, {
      minimumNoticeMinutes: 2880,
    });
    expect(request.status).toBe(201);
    await release(holder, occupied.data.id);
    expect(
      await one(pool, "SELECT id FROM live_window_offers WHERE request_id=$1", [
        request.data.id,
      ]),
    ).toBeUndefined();
  });

  it("applies and later releases the per-request anti-spam limit without changing priority", async () => {
    await enable();
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const waiting = await candidate("900043");
    const request = await wait(waiting.token);
    const requestRow = (await one<{
      version: number;
      eligibility_hash: string;
      priority_at: Date;
    }>(
      pool,
      "SELECT version,eligibility_hash,priority_at FROM waitlist_requests WHERE id=$1",
      [request.data.id],
    ))!;
    const booking = (await one<{
      start_at: Date;
      end_at: Date;
      duration_snapshot: number;
      timezone_snapshot: string;
    }>(
      pool,
      "SELECT start_at,end_at,duration_snapshot,timezone_snapshot FROM bookings WHERE id=$1",
      [occupied.data.id],
    ))!;
    for (let index = 1; index <= 3; index++) {
      const oldWindow = (await one<{ id: string }>(
        pool,
        `INSERT INTO live_windows(tenant_id,staff_id,service_id,source_event_key,source_booking_id,source_booking_version,start_at,end_at,duration_snapshot,timezone_snapshot,status,close_reason)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'closed','test_fixture') RETURNING id`,
        [
          f("salon-a"),
          f("staff-a-0"),
          f("service-a-0"),
          `test.cooldown.${index}`,
          occupied.data.id,
          100 + index,
          booking.start_at,
          booking.end_at,
          booking.duration_snapshot,
          booking.timezone_snapshot,
        ],
      ))!;
      await pool.query(
        `INSERT INTO live_window_offers(tenant_id,window_id,request_id,user_id,request_version,eligibility_hash,service_id,staff_id,visit_start_at,visit_end_at,price_minor_snapshot,duration_snapshot,timezone_snapshot,sequence,status,terminal_reason)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,250000,60,$11,1,'declined','test_fixture')`,
        [
          f("salon-a"),
          oldWindow.id,
          request.data.id,
          waiting.userId,
          requestRow.version,
          requestRow.eligibility_hash,
          f("service-a-0"),
          f("staff-a-0"),
          booking.start_at,
          booking.end_at,
          booking.timezone_snapshot,
        ],
      );
    }
    await release(holder, occupied.data.id);
    const currentWindow = (await one<{ id: string; status: string }>(
      pool,
      "SELECT id,status FROM live_windows WHERE source_event_key LIKE 'booking.slot_released:%'",
    ))!;
    expect(currentWindow.status).toBe("exhausted");
    expect(
      await one<{ details: { reason: string } }>(
        pool,
        "SELECT details FROM audit_log WHERE action='live_window.candidate_skipped' AND object_id=$1",
        [request.data.id],
      ),
    ).toMatchObject({ details: { reason: "REQUEST_DAILY_LIMIT" } });
    expect(
      await one<{ status: string; priority_at: Date }>(
        pool,
        "SELECT status,priority_at FROM waitlist_requests WHERE id=$1",
        [request.data.id],
      ),
    ).toMatchObject({ status: "active", priority_at: requestRow.priority_at });
    await pool.query(
      "UPDATE live_window_offers SET created_at=now()-interval '25 hours' WHERE request_id=$1",
      [request.data.id],
    );
    await pool.query(
      "UPDATE live_windows SET status='matching',close_reason=NULL WHERE id=$1",
      [currentWindow.id],
    );
    await tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(724992)");
      await advanceWindow(db, currentWindow.id);
    });
    expect(
      await one<{ status: string }>(
        pool,
        "SELECT status FROM live_window_offers WHERE window_id=$1",
        [currentWindow.id],
      ),
    ).toMatchObject({ status: "pending_delivery" });
    expect(
      await one<{ priority_at: Date }>(
        pool,
        "SELECT priority_at FROM waitlist_requests WHERE id=$1",
        [request.data.id],
      ),
    ).toMatchObject({ priority_at: requestRow.priority_at });
  });

  it("revokes and suppresses active work when the platform flag is disabled", async () => {
    await enable();
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const waiting = await candidate("900023");
    const request = await wait(waiting.token);
    await release(holder, occupied.data.id);
    await pool.query(
      "UPDATE system_state SET value='{\"enabled\":true}'::jsonb WHERE key='live_window_kill_switch'",
    );
    await runLiveWindowCycle();
    expect(
      await one<{ status: string; suspension_reason: string }>(
        pool,
        "SELECT status,suspension_reason FROM waitlist_requests WHERE id=$1",
        [request.data.id],
      ),
    ).toMatchObject({ status: "paused", suspension_reason: "PLATFORM_DISABLED" });
    expect(
      await one<{ status: string }>(
        pool,
        "SELECT status FROM live_window_offers WHERE request_id=$1",
        [request.data.id],
      ),
    ).toMatchObject({ status: "revoked" });
    expect(
      await one<{ state: string }>(
        pool,
        "SELECT state FROM deliveries WHERE live_window_offer_id IN (SELECT id FROM live_window_offers WHERE request_id=$1)",
        [request.data.id],
      ),
    ).toMatchObject({ state: "suppressed" });
  });

  it("cancels a request, revokes its offer, and suppresses pending delivery", async () => {
    await enable();
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const waiting = await candidate("900034");
    const request = await wait(waiting.token);
    await release(holder, occupied.data.id);
    const cancelled = await req(
      "POST",
      `/api/v1/me/waitlist-requests/${request.data.id}/cancel`,
      waiting.token,
      { expectedVersion: request.data.version, reason: "Больше не нужно" },
    );
    expect(cancelled.status, JSON.stringify(cancelled.error)).toBe(201);
    expect(
      await one<{ status: string }>(
        pool,
        "SELECT status FROM live_window_offers WHERE request_id=$1",
        [request.data.id],
      ),
    ).toMatchObject({ status: "revoked" });
    expect(
      await one<{ state: string }>(
        pool,
        "SELECT state FROM deliveries WHERE live_window_offer_id IN (SELECT id FROM live_window_offers WHERE request_id=$1)",
        [request.data.id],
      ),
    ).toMatchObject({ state: "suppressed" });
  });

  it("moves a stopped bot aside and offers the window to the next candidate", async () => {
    await enable();
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const stopped = await candidate("900024");
    const next = await candidate("900025");
    const stoppedRequest = await wait(stopped.token);
    const nextRequest = await wait(next.token);
    await pool.query(
      "UPDATE waitlist_requests SET priority_at=CASE id WHEN $1 THEN now()-interval '2 hours' ELSE now()-interval '1 hour' END WHERE id=ANY($2::uuid[])",
      [stoppedRequest.data.id, [stoppedRequest.data.id, nextRequest.data.id]],
    );
    await release(holder, occupied.data.id);
    const hook = await app.inject({
      method: "POST",
      url: "/integrations/max/webhook",
      headers: { "x-max-bot-api-secret": "demo-webhook-secret" },
      payload: {
        update_type: "bot_stopped",
        timestamp: 9000,
        user: { user_id: "900024" },
      },
    });
    expect(hook.statusCode).toBe(200);
    await processInbox();
    expect(
      await one<{ status: string }>(
        pool,
        "SELECT status FROM waitlist_requests WHERE id=$1",
        [stoppedRequest.data.id],
      ),
    ).toMatchObject({ status: "paused_channel_unavailable" });
    expect(
      await one<{ request_id: string }>(
        pool,
        "SELECT request_id FROM live_window_offers WHERE status='pending_delivery' ORDER BY sequence DESC LIMIT 1",
      ),
    ).toMatchObject({ request_id: nextRequest.data.id });
  });

  it("skips a wrong specific master and matches an any-master request", async () => {
    await enable();
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const otherHolder = await candidate("900029");
    expect(
      (
        await book(
          otherHolder.token,
          await quote(otherHolder.token, "a", 10, {
            staffId: f("staff-a-1"),
          }),
        )
      ).status,
    ).toBe(201);
    const specific = await candidate("900026");
    const any = await candidate("900027");
    const wrong = await waitWith(specific.token, { staffIds: [f("staff-a-1")] });
    const open = await waitWith(any.token, { staffIds: [] });
    await pool.query(
      "UPDATE waitlist_requests SET priority_at=CASE id WHEN $1 THEN now()-interval '2 hours' ELSE now()-interval '1 hour' END WHERE id=ANY($2::uuid[])",
      [wrong.data.id, [wrong.data.id, open.data.id]],
    );
    await release(holder, occupied.data.id);
    expect(
      await one<{ request_id: string }>(
        pool,
        "SELECT request_id FROM live_window_offers LIMIT 1",
      ),
    ).toMatchObject({ request_id: open.data.id });
  });

  it("revokes an open linked offer when the source booking changed", async () => {
    await enable();
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const waiting = await candidate("900028");
    const later = await book(waiting.token, await quote(waiting.token, "a", 12));
    const request = await wait(waiting.token, later.data.id);
    await release(holder, occupied.data.id);
    const offer = await offerFor(waiting.userId);
    const moveQuote = await req<{ id: string }>(
      "POST",
      `/api/v1/me/bookings/${later.data.id}/reschedule-quotes`,
      waiting.token,
      {
        serviceId: f("service-a-0"),
        staffId: f("staff-a-0"),
        startAt: tomorrow(15),
        expectedVersion: 1,
      },
    );
    expect(moveQuote.status).toBe(201);
    const moved = await req(
      "POST",
      `/api/v1/me/bookings/${later.data.id}/reschedule`,
      waiting.token,
      {
        quoteId: moveQuote.data.id,
        expectedVersion: 1,
        confirmedTermsVersion: "booking-p0-v1",
      },
    );
    expect(moved.status, JSON.stringify(moved.error)).toBe(201);
    expect(
      await one<{ payload: { cascade: boolean } }>(
        pool,
        "SELECT payload FROM domain_outbox WHERE event_key LIKE $1 ORDER BY created_at DESC LIMIT 1",
        [`booking.slot_released:${later.data.id}:%`],
      ),
    ).toMatchObject({ payload: { cascade: true } });
    const rejected = await req<{ status: string; reason: string }>(
      "POST",
      `/api/v1/me/live-window-offers/${offer.id}/accept`,
      waiting.token,
      {
        expectedVersion: offer.version,
        confirmedTermsVersion: "booking-p0-v1",
      },
    );
    expect(rejected.data).toMatchObject({
      status: "unavailable",
      reason: "LINKED_BOOKING_CHANGED",
    });
    expect(
      await one<{ status: string; suspension_reason: string }>(
        pool,
        "SELECT status,suspension_reason FROM waitlist_requests WHERE id=$1",
        [request.data.id],
      ),
    ).toMatchObject({
      status: "suspended_incompatible",
      suspension_reason: "LINKED_BOOKING_CHANGED",
    });
    expect(
      await one<{ start_at: Date; version: number }>(
        pool,
        "SELECT start_at,version FROM bookings WHERE id=$1",
        [later.data.id],
      ),
    ).toMatchObject({ start_at: new Date(tomorrow(15)), version: 2 });
  });

  it("uses the salon timezone when matching and snapshotting an offer", async () => {
    await enable();
    await pool.query(
      "UPDATE tenants SET timezone='Asia/Yekaterinburg' WHERE id=$1",
      [f("salon-a")],
    );
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const waiting = await candidate("900030");
    const localDate = DateTime.now()
      .setZone("Asia/Yekaterinburg")
      .plus({ days: 1 })
      .toISODate()!;
    const request = await waitWith(waiting.token, {
      dateFrom: localDate,
      dateTo: localDate,
      weekdays: [DateTime.fromISO(localDate).weekday],
      dailyStartLocal: "12:00",
      dailyEndLocal: "13:00",
    });
    expect(request.status, JSON.stringify(request.error)).toBe(201);
    await release(holder, occupied.data.id);
    expect(
      await one<{
        timezone_snapshot: string;
        visit_start_at: Date;
        visit_end_at: Date;
      }>(
        pool,
        "SELECT timezone_snapshot,visit_start_at,visit_end_at FROM live_window_offers WHERE request_id=$1",
        [request.data.id],
      ),
    ).toMatchObject({ timezone_snapshot: "Asia/Yekaterinburg" });
  });

  it("uses the current shorter duration and rejects a duration longer than the window", async () => {
    await enable();
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const waiting = await candidate("900031");
    const request = await wait(waiting.token);
    expect(request.status).toBe(201);
    await pool.query(
      "UPDATE services SET duration_min=30 WHERE id=$1",
      [f("service-a-0")],
    );
    await release(holder, occupied.data.id);
    const short = (await one<{
      duration_snapshot: number;
      visit_start_at: Date;
      visit_end_at: Date;
    }>(
      pool,
      "SELECT duration_snapshot,visit_start_at,visit_end_at FROM live_window_offers WHERE request_id=$1",
      [request.data.id],
    ))!;
    expect(short.duration_snapshot).toBe(30);
    expect(short.visit_end_at.getTime() - short.visit_start_at.getTime()).toBe(
      30 * 60_000,
    );

    await pool.query("TRUNCATE users,tenants,system_state,max_inbox CASCADE");
    await seed();
    await enable();
    const secondHolder = await login("client");
    const secondOccupied = await book(secondHolder, await quote(secondHolder));
    const secondWaiting = await candidate("900032");
    const secondRequest = await wait(secondWaiting.token);
    expect(secondRequest.status).toBe(201);
    await pool.query(
      "UPDATE services SET duration_min=90 WHERE id=$1",
      [f("service-a-0")],
    );
    await release(secondHolder, secondOccupied.data.id);
    expect(
      await one(pool, "SELECT id FROM live_window_offers WHERE request_id=$1", [
        secondRequest.data.id,
      ]),
    ).toBeUndefined();
    expect(
      await one<{ status: string }>(
        pool,
        "SELECT status FROM live_windows ORDER BY created_at DESC LIMIT 1",
      ),
    ).toMatchObject({ status: "exhausted" });
  });

  it("honors a closed schedule exception introduced before matching", async () => {
    await enable();
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const waiting = await candidate("900035");
    const request = await wait(waiting.token);
    expect(request.status).toBe(201);
    await pool.query(
      "INSERT INTO schedule_exceptions(tenant_id,staff_id,local_date,mode) VALUES($1,$2,$3,'closed')",
      [f("salon-a"), f("staff-a-0"), date()],
    );
    await release(holder, occupied.data.id);
    expect(
      await one(pool, "SELECT id FROM live_window_offers WHERE request_id=$1", [
        request.data.id,
      ]),
    ).toBeUndefined();
    expect(
      await one<{ status: string }>(
        pool,
        "SELECT status FROM live_windows ORDER BY created_at DESC LIMIT 1",
      ),
    ).toMatchObject({ status: "exhausted" });
  });

  it("suspends a request when its selected master becomes inactive", async () => {
    await enable();
    const holder = await login("client");
    expect((await book(holder, await quote(holder))).status).toBe(201);
    const waiting = await candidate("900036");
    const request = await wait(waiting.token);
    expect(request.status).toBe(201);
    await pool.query("UPDATE staff SET active=false WHERE id=$1", [
      f("staff-a-0"),
    ]);
    await runLiveWindowCycle();
    expect(
      await one<{ status: string; suspension_reason: string }>(
        pool,
        "SELECT status,suspension_reason FROM waitlist_requests WHERE id=$1",
        [request.data.id],
      ),
    ).toMatchObject({
      status: "suspended_incompatible",
      suspension_reason: "STAFF_INACTIVE",
    });
  });

  it("revokes an offer and changes fingerprint when match conditions change", async () => {
    await enable();
    const holder = await login("client");
    const occupied = await book(holder, await quote(holder));
    const waiting = await candidate("900033");
    const request = await wait(waiting.token);
    await pool.query(
      "UPDATE waitlist_requests SET priority_at=now()-interval '1 day' WHERE id=$1",
      [request.data.id],
    );
    const before = (await one<{
      eligibility_hash: string;
      priority_at: Date;
      version: number;
    }>(
      pool,
      "SELECT eligibility_hash,priority_at,version FROM waitlist_requests WHERE id=$1",
      [request.data.id],
    ))!;
    await release(holder, occupied.data.id);
    const changed = await req<{
      eligibilityHash: string;
      priorityAt: string;
      version: number;
    }>(
      "PATCH",
      `/api/v1/me/waitlist-requests/${request.data.id}`,
      waiting.token,
      {
        expectedVersion: before.version,
        dateFrom: date(),
        dateTo: date(),
        dailyStartLocal: "10:00",
        dailyEndLocal: "11:30",
      },
    );
    expect(changed.status, JSON.stringify(changed.error)).toBe(200);
    const after = (await one<{
      eligibility_hash: string;
      priority_at: Date;
      version: number;
    }>(
      pool,
      "SELECT eligibility_hash,priority_at,version FROM waitlist_requests WHERE id=$1",
      [request.data.id],
    ))!;
    expect(after.eligibility_hash).not.toBe(before.eligibility_hash);
    expect(after.priority_at.getTime()).toBeGreaterThan(before.priority_at.getTime());
    expect(after.version).toBe(before.version + 1);
    expect(
      await one<{ status: string }>(
        pool,
        "SELECT status FROM live_window_offers WHERE request_id=$1",
        [request.data.id],
      ),
    ).toMatchObject({ status: "revoked" });
  });

  it("enforces owner/admin/master operational permissions", async () => {
    await enable();
    const owner = await login("owner-a");
    const admin = await login("admin");
    const master = await login("master");
    expect(
      (await req("GET", `/api/v1/work/${f("salon-a")}/live-window/settings`, admin)).status,
    ).toBe(200);
    expect(
      (
        await req(
          "PATCH",
          `/api/v1/work/${f("salon-a")}/live-window/settings`,
          admin,
          {
            expectedVersion: 1,
            enabled: true,
            paused: false,
            offerTtlMinutes: 10,
            minimumNoticeMinutes: 0,
            quietStart: "00:00",
            quietEnd: "23:59",
          },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await req(
          "POST",
          `/api/v1/work/${f("salon-a")}/live-window/pause`,
          admin,
          { expectedVersion: 1, reason: "Проверка администратора" },
        )
      ).status,
    ).toBe(201);
    expect(
      (await req("GET", `/api/v1/work/${f("salon-a")}/live-window/summary`, master)).status,
    ).toBe(403);
    expect(
      (
        await req(
          "POST",
          `/api/v1/work/${f("salon-a")}/live-window/resume`,
          owner,
          { expectedVersion: 2 },
        )
      ).status,
    ).toBe(201);
  });

  it("returns ordinary slots instead of creating a needless request", async () => {
    await enable();
    const waiting = await candidate("900042");
    const result = await wait(waiting.token);
    expect(result.status).toBe(409);
    expect(result.error.code).toBe("SLOTS_AVAILABLE");
    expect(result.error.details.slots).toBeInstanceOf(Array);
    expect(
      Number(
        (
          await one<{ n: string }>(
            pool,
            "SELECT count(*)::text n FROM waitlist_requests WHERE user_id=$1",
            [waiting.userId],
          )
        )!.n,
      ),
    ).toBe(0);
  });
});
