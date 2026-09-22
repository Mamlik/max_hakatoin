import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, list, route } from "./http.js";
import { one, rows } from "../db/db.js";
import { fail, required, version } from "./errors.js";
import { loyaltyCards } from "./loyalty.js";

export function loyaltyRoutes(app: FastifyInstance) {
  route(
    app,
    "GET",
    "/api/v1/me/loyalty",
    {
      description: "Прогресс по услугам: N платных посещений и одно бесплатное",
    },
    async ({ db, actor }) => list(await loyaltyCards(db, actor.id), 1000),
  );
  route(
    app,
    "GET",
    "/api/v1/me/loyalty-rewards",
    { description: "Личные бесплатные посещения" },
    async ({ db, actor }) =>
      list(
        await rows(
          db,
          `SELECT r.*,t.name tenant_name,t.public_code FROM loyalty_rewards r JOIN customers c ON c.id=r.customer_id JOIN tenants t ON t.id=r.tenant_id WHERE c.user_id=$1 ORDER BY r.issued_at DESC`,
          [actor.id],
        ),
        1000,
      ),
  );
  route(
    app,
    "GET",
    "/api/v1/work/:t/customers/:c/loyalty",
    {
      roles: ["owner", "admin"],
      description: "Прогресс и бесплатные визиты клиента салона",
    },
    async ({ db, p }) => {
      required(
        await one(db, "SELECT id FROM customers WHERE tenant_id=$1 AND id=$2", [
          p.t,
          p.c,
        ]),
      );
      return {
        items: await loyaltyCards(db, undefined, p.t, p.c),
        rewards: await rows(
          db,
          "SELECT * FROM loyalty_rewards WHERE tenant_id=$1 AND customer_id=$2 ORDER BY issued_at DESC",
          [p.t, p.c],
        ),
      };
    },
  );
  route(
    app,
    "GET",
    "/api/v1/work/:t/loyalty-programs",
    { roles: ["owner", "admin"], description: "Программы лояльности салона" },
    async ({ db, p }) =>
      list(
        await rows(
          db,
          "SELECT p.*,s.name service_name,EXISTS(SELECT 1 FROM loyalty_stamps ls WHERE ls.program_id=p.id) has_activity FROM loyalty_programs p JOIN services s ON s.id=p.service_id WHERE p.tenant_id=$1 ORDER BY s.name",
          [p.t],
        ),
        1000,
      ),
  );
  route(
    app,
    "PUT",
    "/api/v1/work/:t/loyalty-programs",
    {
      roles: ["owner"],
      description:
        "Настроить количество платных посещений для бесплатного визита той же услуги",
      schema: z
        .object({
          serviceId: z.uuid(),
          visitsRequired: z.number().int().min(2).max(50),
          enabled: z.boolean(),
          expectedVersion: z.number().int().min(0),
        })
        .strict(),
    },
    async ({ db, p, b, actor }) => {
      required(
        await one(db, "SELECT id FROM services WHERE id=$1 AND tenant_id=$2", [
          b.serviceId,
          p.t,
        ]),
      );
      const old = await one<{
        id: string;
        version: number;
        visits_required: number;
      }>(
        db,
        "SELECT * FROM loyalty_programs WHERE tenant_id=$1 AND service_id=$2",
        [p.t, b.serviceId],
      );
      version(old ?? { version: 0 }, b.expectedVersion);
      if (
        old &&
        old.visits_required !== b.visitsRequired &&
        (await one(
          db,
          "SELECT 1 FROM loyalty_stamps WHERE program_id=$1 LIMIT 1",
          [old.id],
        ))
      )
        fail(
          409,
          "LOYALTY_TERMS_LOCKED",
          "У клиентов уже есть отметки. Порог этой программы менять нельзя; можно приостановить накопление.",
        );
      const result = required(
        await one<{ id: string }>(
          db,
          "INSERT INTO loyalty_programs(tenant_id,service_id,visits_required,enabled) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,service_id) DO UPDATE SET visits_required=EXCLUDED.visits_required,enabled=EXCLUDED.enabled,version=loyalty_programs.version+1 RETURNING *",
          [p.t, b.serviceId, b.visitsRequired, b.enabled],
        ),
      );
      await audit(db, p.t!, actor.id, "loyalty.configured", result.id, {
        visitsRequired: b.visitsRequired,
        enabled: b.enabled,
      });
      return result;
    },
  );
}
