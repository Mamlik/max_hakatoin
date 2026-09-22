import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { DateTime } from "luxon";
import { createApp } from "../apps/api/main.js";
import { pool, one, rows, tx } from "../packages/db/db.js";
import { seed, fixtureId as f } from "../packages/db/seed.js";
import { signInitData } from "../packages/backend/auth.js";
import { processInbox } from "../apps/worker/main.js";
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
