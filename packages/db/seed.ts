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
const extraDemoSalons = [
  { code: "teplyi-veter", name: "Тёплый ветер", category: "Волосы", address: "Москва, Тихая улица, 4", accent: "amber", services: ["Стрижка и укладка", "Уход для волос"], staff: ["Арина", "Валерия"] },
  { code: "forma-nogtei", name: "Форма ногтей", category: "Ногтевой сервис", address: "Москва, Садовая улица, 18", accent: "rose", services: ["Маникюр с покрытием", "Укрепление ногтей"], staff: ["Кира", "Элина"] },
  { code: "liniya-lica", name: "Линия лица", category: "Брови и ресницы", address: "Москва, Новая улица, 6", accent: "violet", services: ["Оформление бровей", "Ламинирование ресниц"], staff: ["Майя", "Агата"] },
  { code: "tikhiy-spa", name: "Тихий spa", category: "Массаж и spa", address: "Москва, Лесной проспект, 11", accent: "teal", services: ["Расслабляющий массаж", "Уход за телом"], staff: ["Марк", "Ника"] },
  { code: "chistaya-kozha", name: "Чистая кожа", category: "Косметология", address: "Москва, Речной переулок, 9", accent: "blue", services: ["Уход за лицом", "Массаж лица"], staff: ["Алиса", "Дина"] },
  { code: "dobryi-barber", name: "Добрый barber", category: "Барбершоп", address: "Москва, Кирпичная улица, 21", accent: "slate", services: ["Мужская стрижка", "Стрижка бороды"], staff: ["Лев", "Тимур"] },
  { code: "myagkii-svet", name: "Мягкий свет", category: "Волосы", address: "Москва, Липовая улица, 15", accent: "amber", services: ["Окрашивание волос", "Стрижка и укладка"], staff: ["Вера", "Яна"] },
  { code: "lak-i-mak", name: "Лак и мак", category: "Ногтевой сервис", address: "Москва, Цветочная улица, 3", accent: "rose", services: ["Маникюр с покрытием", "Педикюр"], staff: ["Злата", "Мила"] },
  { code: "prosto-brovi", name: "Просто брови", category: "Брови и ресницы", address: "Москва, Солнечная улица, 8", accent: "violet", services: ["Оформление бровей", "Окрашивание бровей"], staff: ["Таисия", "Лада"] },
  { code: "perezagruzka", name: "Перезагрузка", category: "Массаж и spa", address: "Москва, Берёзовый бульвар, 10", accent: "teal", services: ["Массаж спины", "Расслабляющий массаж"], staff: ["Дамир", "Соня"] },
  { code: "ton-litsa", name: "Тон лица", category: "Косметология", address: "Москва, Озёрная улица, 12", accent: "blue", services: ["Чистка лица", "Уход за лицом"], staff: ["Эмма", "Лилия"] },
  { code: "brat-barber", name: "Брат barber", category: "Барбершоп", address: "Москва, Центральная улица, 27", accent: "slate", services: ["Мужская стрижка", "Камуфляж седины"], staff: ["Роман", "Глеб"] },
  { code: "volna-studio", name: "Волна studio", category: "Волосы", address: "Москва, Морская улица, 5", accent: "amber", services: ["Стрижка и укладка", "Восстанавливающий уход"], staff: ["Олеся", "Марта"] },
  { code: "nezhno", name: "Нежно", category: "Ногтевой сервис", address: "Москва, Малая улица, 14", accent: "rose", services: ["Бережный маникюр", "Маникюр с покрытием"], staff: ["Лина", "Ксения"] },
  { code: "glazur", name: "Глазурь", category: "Брови и ресницы", address: "Москва, Ясная улица, 2", accent: "violet", services: ["Ламинирование ресниц", "Оформление бровей"], staff: ["Ася", "Рита"] },
  { code: "belaya-komnata", name: "Белая комната", category: "Массаж и spa", address: "Москва, Парковая улица, 19", accent: "teal", services: ["Массаж спины", "Уход за телом"], staff: ["Илья", "Ева"] },
  { code: "skin-room", name: "Skin room", category: "Косметология", address: "Москва, Верхняя улица, 16", accent: "blue", services: ["Уход за лицом", "Пилинг"], staff: ["Мира", "Диана"] },
  { code: "staryi-master", name: "Старый мастер", category: "Барбершоп", address: "Москва, Рабочая улица, 31", accent: "slate", services: ["Мужская стрижка", "Классическое бритьё"], staff: ["Арсений", "Юрий"] },
] as const;
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
    for (const [index, salon] of extraDemoSalons.entries()) {
      const ownerId = fixtureId(`owner-${salon.code}`);
      await db.query(
        "INSERT INTO users(id,max_user_id,display_name,is_test) VALUES($1,$2,$3,true) ON CONFLICT DO NOTHING",
        [ownerId, 910101 + index, `Владелец · ${salon.name}`],
      );
      await db.query(
        "INSERT INTO bot_channels(user_id,state,generation) VALUES($1,'active',1) ON CONFLICT DO NOTHING",
        [ownerId],
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
        "INSERT INTO loyalty_programs(tenant_id,service_id,visits_required,free_visits_count) VALUES($1,$2,5,1)",
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
    for (const salon of extraDemoSalons) {
      const key = salon.code;
      const tenantId = fixtureId(`salon-${key}`);
      if (await one(db, "SELECT id FROM tenants WHERE id=$1", [tenantId]))
        continue;
      const ownerId = fixtureId(`owner-${key}`);
      const categoryId = fixtureId(`category-${key}`);
      const style = {
        accent: salon.accent,
        description: `${salon.category}: уютная студия с внимательным сервисом и удобной записью.`,
        categoryOrder: [categoryId],
      };
      const profile = {
        name: salon.name,
        category: salon.category,
        address: salon.address,
        contact: "Демо-данные · запись через приложение",
        timezone: "Europe/Moscow",
      };
      await db.query(
        "INSERT INTO tenants(id,public_code,name,category,address,contact,timezone,status,operational_recipient_id,draft_style,published_style,published_profile,is_test) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8,$9,$9,$10,true)",
        [tenantId, key, salon.name, salon.category, profile.address, profile.contact, profile.timezone, ownerId, JSON.stringify(style), JSON.stringify(profile)],
      );
      await db.query(
        "INSERT INTO memberships(id,tenant_id,user_id,role) VALUES($1,$2,$3,'owner')",
        [fixtureId(`membership-owner-${key}`), tenantId, ownerId],
      );
      await db.query(
        "INSERT INTO categories(id,tenant_id,name) VALUES($1,$2,$3)",
        [categoryId, tenantId, salon.category],
      );
      for (let n = 0; n < salon.services.length; n++) {
        await db.query(
          "INSERT INTO services(id,tenant_id,category_id,name,description,duration_min,price_minor) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [fixtureId(`service-${key}-${n}`), tenantId, categoryId, salon.services[n], "Популярная услуга студии, консультация включена", n === 0 ? 60 : 45, n === 0 ? 250000 : 175000],
        );
      }
      await db.query(
        "INSERT INTO loyalty_programs(tenant_id,service_id,visits_required,free_visits_count) VALUES($1,$2,5,1)",
        [tenantId, fixtureId(`service-${key}-0`)],
      );
      const weekly: Weekday[] = Array.from({ length: 7 }, (_, i) => ({
        weekday: i + 1,
        intervals: [
          { kind: "work", start: "09:00", end: "20:00" },
          { kind: "break", start: "13:00", end: "14:00" },
        ],
      }));
      for (let n = 0; n < salon.staff.length; n++) {
        const staffId = fixtureId(`staff-${key}-${n}`);
        await db.query(
          "INSERT INTO staff(id,tenant_id,name,description) VALUES($1,$2,$3,$4)",
          [staffId, tenantId, salon.staff[n], "Мастер студии · демонстрационная карточка"],
        );
        for (let service = 0; service < salon.services.length; service++)
          await db.query(
            "INSERT INTO staff_services(tenant_id,staff_id,service_id) VALUES($1,$2,$3)",
            [tenantId, staffId, fixtureId(`service-${key}-${service}`)],
          );
        await db.query(
          "INSERT INTO schedules(tenant_id,staff_id,effective_from,weekly,version) VALUES($1,$2,$3,$4,1)",
          [tenantId, staffId, DateTime.now().minus({ days: 30 }).toISODate(), JSON.stringify(weekly)],
        );
        await snapshotDays(
          db,
          (await one<Tenant>(db, "SELECT * FROM tenants WHERE id=$1", [tenantId]))!,
          staffId,
          DateTime.now().minus({ days: 7 }).toISODate()!,
          38,
        );
      }
      await db.query(
        "INSERT INTO customers(id,tenant_id,user_id,display_name,tags,is_test) VALUES($1,$2,$3,$4,$5,true)",
        [fixtureId(`customer-${key}`), tenantId, fixtureId("client"), "Анна · демонстрационный клиент", ["Демо"]],
      );
    }
  });
  for (const key of ["a", "b"])
    await pool.query(
      "INSERT INTO loyalty_programs(tenant_id,service_id,visits_required,free_visits_count) SELECT $1,s.id,5,1 FROM services s WHERE s.id=$2 AND NOT EXISTS(SELECT 1 FROM loyalty_programs p WHERE p.tenant_id=$1 AND p.service_id=s.id)",
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
