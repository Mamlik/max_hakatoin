import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { pool, tx, one } from "./db.js";
import { config } from "../backend/config.js";
import { snapshotDays } from "../backend/scheduling.js";
import type { Tenant, Weekday } from "../backend/types.js";
export const fixtureId = (name: string) => {
  const s = createHash("sha256")
    .update(`max-salons-demo:${name}`)
    .digest("hex");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`;
};
export async function seed() {
  if (
    !["demo", "local", "test"].includes(config.APP_ENV) ||
    config.MAX_MODE !== "mock"
  )
    throw new Error("Demo seed is prohibited outside mock demo/local/test");
  await tx(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(724992)");
    for (const [key, maxId, name] of [
      ["client", "900001", "Анна · клиент"],
      ["owner-a", "900002", "Мария · владелец A"],
      ["owner-b", "900003", "Елена · владелец B"],
      ["admin", "900004", "Ольга · администратор"],
      ["master", "900005", "София · мастер"],
      ["new-owner", "900006", "Новый владелец"],
    ]) {
      await db.query(
        "INSERT INTO users(id,max_user_id,display_name,is_test) VALUES($1,$2,$3,true) ON CONFLICT DO NOTHING",
        [fixtureId(key!), maxId, name],
      );
      await db.query(
        "INSERT INTO bot_channels(user_id,state,generation) VALUES($1,'active',1) ON CONFLICT DO NOTHING",
        [fixtureId(key!)],
      );
    }
    for (const [key, name, code, category, accent] of [
      ["a", "Линия · студия волос", "line", "Волосы", "violet"],
      ["b", "Точка · nail studio", "tochka", "Ногтевой сервис", "rose"],
    ]) {
      const tenantId = fixtureId(`salon-${key}`);
      if (await one(db, "SELECT id FROM tenants WHERE id=$1", [tenantId]))
        continue;
      const ownerId = fixtureId(`owner-${key}`);
      const style = {
        accent,
        description:
          key === "a"
            ? "Точное попадание в ваш стиль. Стрижки, уход и спокойное время для себя."
            : "Детали, которые радуют каждый день. Маникюр, бережный уход и любимые оттенки.",
        categoryOrder: [fixtureId(`category-${key}`)],
      };
      const profile = {
        name,
        category,
        address:
          key === "a"
            ? "Москва, Тестовая улица, 12"
            : "Москва, Демонстрационный переулок, 7",
        contact: "Демо-данные · запись через приложение",
        timezone: "Europe/Moscow",
      };
      await db.query(
        "INSERT INTO tenants(id,public_code,name,category,address,contact,timezone,status,operational_recipient_id,draft_style,published_style,published_profile,is_test) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8,$9,$9,$10,true)",
        [
          tenantId,
          code,
          name,
          category,
          profile.address,
          profile.contact,
          profile.timezone,
          ownerId,
          JSON.stringify(style),
          JSON.stringify(profile),
        ],
      );
      await db.query(
        "INSERT INTO memberships(id,tenant_id,user_id,role) VALUES($1,$2,$3,'owner')",
        [fixtureId(`membership-owner-${key}`), tenantId, ownerId],
      );
      if (key === "a")
        for (const role of ["admin", "master"])
          await db.query(
            "INSERT INTO memberships(id,tenant_id,user_id,role) VALUES($1,$2,$3,$4)",
            [fixtureId(`membership-${role}`), tenantId, fixtureId(role), role],
          );
      await db.query(
        "INSERT INTO categories(id,tenant_id,name) VALUES($1,$2,$3)",
        [fixtureId(`category-${key}`), tenantId, category],
      );
      const names =
        key === "a"
          ? ["Стрижка и укладка", "Восстанавливающий уход"]
          : ["Маникюр с покрытием", "Бережный маникюр"];
      for (let n = 0; n < 2; n++)
        await db.query(
          "INSERT INTO services(id,tenant_id,category_id,name,description,duration_min,price_minor) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            fixtureId(`service-${key}-${n}`),
            tenantId,
            fixtureId(`category-${key}`),
            names[n],
            n === 0
              ? "Основная услуга студии, консультация включена"
              : "Внимание к деталям и индивидуальный подход",
            n === 0 ? 60 : 30,
            n === 0 ? 250000 : 150000,
          ],
        );
      await db.query(
        "INSERT INTO loyalty_programs(tenant_id,service_id,visits_required) VALUES($1,$2,5)",
        [tenantId, fixtureId(`service-${key}-0`)],
      );
      const weekly: Weekday[] = Array.from({ length: 7 }, (_, i) => ({
        weekday: i + 1,
        intervals: [
          { kind: "work", start: "09:00", end: "20:00" },
          { kind: "break", start: "13:00", end: "14:00" },
        ],
      }));
      for (let n = 0; n < 2; n++) {
        const staffId = fixtureId(`staff-${key}-${n}`);
        await db.query(
          "INSERT INTO staff(id,tenant_id,name,description,membership_id) VALUES($1,$2,$3,$4,$5)",
          [
            staffId,
            tenantId,
            key === "a"
              ? n === 0
                ? "София"
                : "Александр"
              : n === 0
                ? "Полина"
                : "Алиса",
            "Мастер студии · демонстрационная карточка",
            key === "a" && n === 0 ? fixtureId("membership-master") : null,
          ],
        );
        for (let s = 0; s < 2; s++)
          await db.query(
            "INSERT INTO staff_services(tenant_id,staff_id,service_id) VALUES($1,$2,$3)",
            [tenantId, staffId, fixtureId(`service-${key}-${s}`)],
          );
        await db.query(
          "INSERT INTO schedules(tenant_id,staff_id,effective_from,weekly,version) VALUES($1,$2,$3,$4,1)",
          [
            tenantId,
            staffId,
            DateTime.now().minus({ days: 30 }).toISODate(),
            JSON.stringify(weekly),
          ],
        );
      }
      const customerId = fixtureId(`customer-${key}`);
      await db.query(
        "INSERT INTO customers(id,tenant_id,user_id,display_name,tags,is_test) VALUES($1,$2,$3,$4,$5,true)",
        [customerId, tenantId, fixtureId("client"), "Анна", ["Демо"]],
      );
      await db.query(
        "INSERT INTO customers(id,tenant_id,display_name,contact,tags,is_test) VALUES($1,$2,$3,$4,$5,true)",
        [
          fixtureId(`manual-${key}`),
          tenantId,
          "Тестовый ручной клиент",
          "Вымышленный контакт",
          ["Ручная карточка"],
        ],
      );
      for (const [n, status] of [
        "completed",
        "cancelled",
        "no_show",
        "confirmed",
      ].entries()) {
        const start = DateTime.now()
          .setZone("Europe/Moscow")
          .minus({ days: 4 - n })
          .set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
        await db.query(
          "INSERT INTO bookings(id,tenant_id,customer_id,user_id,staff_id,service_id,start_at,end_at,timezone_snapshot,status,source,service_name_snapshot,duration_snapshot,price_minor_snapshot,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,60,250000,$13)",
          [
            fixtureId(`booking-${key}-${n}`),
            tenantId,
            customerId,
            fixtureId("client"),
            fixtureId(`staff-${key}-0`),
            fixtureId(`service-${key}-0`),
            start.toJSDate(),
            start.plus({ hours: 1 }).toJSDate(),
            "Europe/Moscow",
            status,
            "self",
            names[0],
            fixtureId("client"),
          ],
        );
      }
      const tenant = (await one<Tenant>(
        db,
        "SELECT * FROM tenants WHERE id=$1",
        [tenantId],
      ))!;
      for (let n = 0; n < 2; n++)
        await snapshotDays(
          db,
          tenant,
          fixtureId(`staff-${key}-${n}`),
          DateTime.now().minus({ days: 7 }).toISODate()!,
          38,
        );
      await db.query(
        "INSERT INTO schedule_exceptions(tenant_id,staff_id,local_date,mode) VALUES($1,$2,$3,'closed')",
        [
          tenantId,
          fixtureId(`staff-${key}-1`),
          DateTime.now().plus({ days: 3 }).toISODate(),
        ],
      );
    }
  });
  for (const key of ["a", "b"])
    await pool.query(
      "INSERT INTO loyalty_programs(tenant_id,service_id,visits_required) SELECT $1,s.id,5 FROM services s WHERE s.id=$2 AND NOT EXISTS(SELECT 1 FROM loyalty_programs p WHERE p.tenant_id=$1 AND p.service_id=s.id)",
      [fixtureId(`salon-${key}`), fixtureId(`service-${key}-0`)],
    );
  console.log("Demo fixtures ready. Existing salon data was preserved.");
}
if (!process.env.VITEST) {
  try {
    await seed();
  } finally {
    await pool.end();
  }
}
