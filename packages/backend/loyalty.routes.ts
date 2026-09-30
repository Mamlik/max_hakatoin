import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, list, route } from "./http.js";
import { one, rows } from "../db/db.js";
import { fail, required, version } from "./errors.js";
import { loyaltyCards } from "./loyalty.js";

const programTerms = z.object({
  name: z.string().trim().min(1).max(120), serviceId: z.uuid(),
  visitsRequired: z.number().int().min(2).max(50),
  rewardType: z.enum(['fixed','percent','free_visits']),
  fixedDiscountMinor: z.number().int().positive().nullable(),
  discountPercent: z.number().int().min(1).max(100).nullable(),
  freeVisitsCount: z.number().int().min(1).max(50).nullable(),
  startsAt: z.iso.datetime({offset:true}).nullable(), endsAt: z.iso.datetime({offset:true}).nullable(),
  rewardValidDays: z.number().int().min(1).max(365).nullable(),
  issueLimit: z.number().int().positive().nullable(),
}).strict().superRefine((v,ctx)=>{
  if ((v.rewardType==='fixed' ? Number(v.fixedDiscountMinor!==null) : 0) +
      (v.rewardType==='percent' ? Number(v.discountPercent!==null) : 0) +
      (v.rewardType==='free_visits' ? Number(v.freeVisitsCount!==null) : 0) !== 1 ||
      (v.rewardType!=='fixed' && v.fixedDiscountMinor!==null) ||
      (v.rewardType!=='percent' && v.discountPercent!==null) ||
      (v.rewardType!=='free_visits' && v.freeVisitsCount!==null))
    ctx.addIssue({code:'custom',message:'Укажите только номинал выбранного типа награды'});
  if(v.startsAt && v.endsAt && Date.parse(v.endsAt)<=Date.parse(v.startsAt))
    ctx.addIssue({code:'custom',message:'Дата окончания должна быть позже начала'});
});

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
          `SELECT r.*,p.name program_name,t.name tenant_name,t.public_code,(SELECT count(*)::int FROM loyalty_reward_uses u WHERE u.reward_id=r.id AND u.status='reserved') reserved_visits FROM loyalty_rewards r JOIN loyalty_programs p ON p.id=r.program_id JOIN customers c ON c.id=r.customer_id JOIN tenants t ON t.id=r.tenant_id WHERE c.user_id=$1 ORDER BY r.issued_at DESC`,
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
          "SELECT r.*,p.name program_name,(SELECT count(*)::int FROM loyalty_reward_uses u WHERE u.reward_id=r.id AND u.status='reserved') reserved_visits FROM loyalty_rewards r JOIN loyalty_programs p ON p.id=r.program_id WHERE r.tenant_id=$1 AND r.customer_id=$2 ORDER BY r.issued_at DESC",
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
        "SELECT * FROM loyalty_programs WHERE tenant_id=$1 AND service_id=$2 ORDER BY created_at,id LIMIT 1",
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
      const result = required(await one<{id:string}>(db,old
        ? "UPDATE loyalty_programs SET visits_required=$2,enabled=$3,status=CASE WHEN $3 THEN 'active' ELSE 'paused' END,version=version+1 WHERE id=$1 RETURNING *"
        : "INSERT INTO loyalty_programs(tenant_id,service_id,visits_required,enabled,status,free_visits_count) VALUES($1,$2,$3,$4,CASE WHEN $4 THEN 'active' ELSE 'paused' END,1) RETURNING *",
        old ? [old.id,b.visitsRequired,b.enabled] : [p.t,b.serviceId,b.visitsRequired,b.enabled]));
      await audit(db, p.t!, actor.id, "loyalty.configured", result.id, {
        visitsRequired: b.visitsRequired,
        enabled: b.enabled,
      });
      return result;
    },
  );
  route(app,'POST','/api/v1/work/:t/loyalty-programs',{
    roles:['owner'],description:'Создать отдельную программу лояльности',schema:programTerms,
  },async({db,p,b,actor})=>{
    required(await one(db,'SELECT id FROM services WHERE id=$1 AND tenant_id=$2 AND active',[b.serviceId,p.t]));
    const result=required(await one(db,
      'INSERT INTO loyalty_programs(tenant_id,service_id,name,visits_required,reward_type,fixed_discount_minor,discount_percent,free_visits_count,starts_at,ends_at,reward_valid_days,issue_limit) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
      [p.t,b.serviceId,b.name,b.visitsRequired,b.rewardType,b.fixedDiscountMinor,b.discountPercent,b.freeVisitsCount,b.startsAt,b.endsAt,b.rewardValidDays,b.issueLimit]));
    await audit(db,p.t!,actor.id,'loyalty.created',(result as {id:string}).id,{terms:b});return result;
  });
  route(app,'PATCH','/api/v1/work/:t/loyalty-programs/:id',{
    roles:['owner'],description:'Изменить программу до первого начисления',schema:programTerms.safeExtend({expectedVersion:z.number().int().positive()}),
  },async({db,p,b,actor})=>{
    const old=required(await one<{id:string;version:number}>(db,'SELECT id,version FROM loyalty_programs WHERE id=$1 AND tenant_id=$2',[p.id,p.t]));
    version(old,b.expectedVersion);
    if(await one(db,'SELECT 1 FROM loyalty_stamps WHERE program_id=$1 UNION SELECT 1 FROM loyalty_rewards WHERE program_id=$1 LIMIT 1',[old.id]))
      fail(409,'LOYALTY_TERMS_LOCKED','После начала накопления создайте новую программу');
    required(await one(db,'SELECT id FROM services WHERE id=$1 AND tenant_id=$2 AND active',[b.serviceId,p.t]));
    const result=required(await one(db,
      'UPDATE loyalty_programs SET service_id=$2,name=$3,visits_required=$4,reward_type=$5,fixed_discount_minor=$6,discount_percent=$7,free_visits_count=$8,starts_at=$9,ends_at=$10,reward_valid_days=$11,issue_limit=$12,version=version+1 WHERE id=$1 RETURNING *',
      [old.id,b.serviceId,b.name,b.visitsRequired,b.rewardType,b.fixedDiscountMinor,b.discountPercent,b.freeVisitsCount,b.startsAt,b.endsAt,b.rewardValidDays,b.issueLimit]));
    await audit(db,p.t!,actor.id,'loyalty.updated',old.id,{terms:b});return result;
  });
  for(const action of ['pause','resume','end'] as const) route(app,'POST',`/api/v1/work/:t/loyalty-programs/:id/${action}`,{
    roles:['owner'],description:`${action} программу`,schema:z.object({expectedVersion:z.number().int().positive()}).strict(),
  },async({db,p,b,actor})=>{
    const old=required(await one<{id:string;version:number;status:string;issue_limit:number|null;issued_total:number}>(db,'SELECT * FROM loyalty_programs WHERE id=$1 AND tenant_id=$2',[p.id,p.t]));
    version(old,b.expectedVersion);
    if(old.status==='ended' || action==='resume' && old.issue_limit!==null && old.issued_total>=old.issue_limit)
      fail(409,'LOYALTY_UNAVAILABLE','Программа завершена или исчерпана');
    const status=action==='end'?'ended':action==='pause'?'paused':'active';
    const result=required(await one(db,'UPDATE loyalty_programs SET status=$2,enabled=$3,version=version+1 WHERE id=$1 RETURNING *',[old.id,status,status==='active']));
    await audit(db,p.t!,actor.id,`loyalty.${action}`,old.id);return result;
  });
}
