import { one, rows, type DB } from "../db/db.js";
import { fail, required } from "./errors.js";
import { audit } from "./http.js";
import { notify } from "./notifications.js";
import type { Booking } from "./types.js";
import { benefitDiscount, type BenefitType } from "./benefits.js";

interface Program {
  id: string;
  tenant_id: string;
  service_id: string;
  visits_required: number;
  enabled: boolean;
  version: number;
  reward_type: BenefitType;
  fixed_discount_minor: number | null;
  discount_percent: number | null;
  free_visits_count: number | null;
  reward_valid_days: number | null;
  issue_limit: number | null;
  issued_total: number;
  starts_at: Date | null;
  ends_at: Date | null;
  status: string;
}
interface Reward {
  id: string;
  status: string;
  reserved_booking_id: string | null;
  redeemed_booking_id: string | null;
  service_id: string;
  reward_type: BenefitType;
  fixed_discount_minor: number | null;
  discount_percent: number | null;
  free_visits_count: number | null;
  remaining_visits: number;
  expires_at: Date | null;
}

export async function checkReward(
  db: DB,
  id: string,
  tenantId: string,
  customerId: string,
  serviceId: string,
  bookingId?: string,
) {
  const reward = required(
    await one<Reward>(
      db,
      "SELECT * FROM loyalty_rewards WHERE id=$1 AND tenant_id=$2 AND customer_id=$3",
      [id, tenantId, customerId],
    ),
  );
  if (
    reward.service_id !== serviceId ||
    (reward.expires_at !== null && reward.expires_at.getTime() <= Date.now() && reward.reserved_booking_id !== bookingId) ||
    !(
      reward.status === "issued" ||
      (reward.status === "reserved" && reward.reserved_booking_id === bookingId)
    )
  )
    fail(
      409,
      "LOYALTY_REWARD_UNAVAILABLE",
      "Награда уже использована, зарезервирована, истекла или относится к другой услуге.",
    );
  const reserved = await one<{count:number}>(db,
    "SELECT count(*)::int count FROM loyalty_reward_uses WHERE reward_id=$1 AND status='reserved' AND booking_id<>COALESCE($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid)",
    [id, bookingId ?? null]);
  if (reward.reward_type === 'free_visits' && reward.remaining_visits - (reserved?.count ?? 0) < 1)
    fail(409, 'LOYALTY_REWARD_UNAVAILABLE', 'У награды не осталось свободных посещений');
  return reward;
}

export function rewardDiscount(reward: Reward, priceMinor: number): number {
  return benefitDiscount(priceMinor, reward.reward_type, reward.fixed_discount_minor, reward.discount_percent);
}

// All calls run inside the shared transactional write gate used by booking commands.
// Booking mutations share an advisory transaction lock, so issue limits and unit
// reservations stay serial even when two staff members complete visits at once.
export async function loyaltyOutcome(db: DB, b: Booking, target: string, actorId: string) {
  if (b.loyalty_reward_id) {
    const reward = required(await one<Reward>(db,
      'SELECT * FROM loyalty_rewards WHERE id=$1 AND tenant_id=$2 AND customer_id=$3',
      [b.loyalty_reward_id,b.tenant_id,b.customer_id]));
    const use = await one<{status:string}>(db,'SELECT status FROM loyalty_reward_uses WHERE reward_id=$1 AND booking_id=$2',[reward.id,b.id]);
    if (target === 'completed') {
      if (use?.status === 'redeemed' || reward.status === 'redeemed' && reward.redeemed_booking_id === b.id) return;
      if (use?.status !== 'reserved' && !(reward.status === 'reserved' && reward.reserved_booking_id === b.id))
        fail(409,'LOYALTY_REWARD_UNAVAILABLE','Награда не зарезервирована для этой записи');
      await db.query("INSERT INTO loyalty_reward_uses(reward_id,booking_id,status) VALUES($1,$2,'redeemed') ON CONFLICT(reward_id,booking_id) DO UPDATE SET status='redeemed'",[reward.id,b.id]);
      if (reward.reward_type === 'free_visits') {
        const remaining = reward.remaining_visits - 1;
        if (remaining < 0) fail(409,'LOYALTY_REWARD_UNAVAILABLE','Бесплатные посещения уже использованы');
        await db.query("UPDATE loyalty_rewards SET remaining_visits=$2,status=CASE WHEN $2=0 THEN 'redeemed' ELSE 'issued' END,reserved_booking_id=NULL,redeemed_booking_id=CASE WHEN $2=0 THEN $3 ELSE redeemed_booking_id END WHERE id=$1",[reward.id,remaining,b.id]);
      } else await db.query("UPDATE loyalty_rewards SET status='redeemed',reserved_booking_id=NULL,redeemed_booking_id=$2 WHERE id=$1",[reward.id,b.id]);
      await audit(db,b.tenant_id,actorId,'loyalty.redeemed',reward.id,{bookingId:b.id});
    } else if (use?.status === 'reserved' || reward.status === 'reserved' && reward.reserved_booking_id === b.id) {
      await db.query("INSERT INTO loyalty_reward_uses(reward_id,booking_id,status) VALUES($1,$2,'released') ON CONFLICT(reward_id,booking_id) DO UPDATE SET status='released'",[reward.id,b.id]);
      await db.query("UPDATE loyalty_rewards SET status=CASE WHEN expires_at<=now() THEN 'expired' ELSE 'issued' END,reserved_booking_id=NULL WHERE id=$1",[reward.id]);
      await audit(db,b.tenant_id,actorId,'loyalty.released',reward.id,{bookingId:b.id});
    }
  }
  const stamps = await rows<{program_id:string;reward_id:string|null;active:boolean}>(db,
    'SELECT program_id,reward_id,active FROM loyalty_stamps WHERE booking_id=$1',[b.id]);
  if (target !== 'completed') {
    const rewards = [...new Set(stamps.filter(s=>s.active && s.reward_id).map(s=>s.reward_id!))];
    for (const rewardId of rewards) {
      const reward=required(await one<Reward>(db,'SELECT * FROM loyalty_rewards WHERE id=$1',[rewardId]));
      if (['reserved','redeemed'].includes(reward.status) || await one(db,"SELECT 1 FROM loyalty_reward_uses WHERE reward_id=$1 AND status IN ('reserved','redeemed') LIMIT 1",[rewardId]))
        fail(409,'LOYALTY_REVIEW_REQUIRED','Этот визит дал награду, которая уже занята записью или использована. Сначала разберите связанный визит.');
      await db.query("UPDATE loyalty_rewards SET status='revoked' WHERE id=$1",[rewardId]);
      await db.query('UPDATE loyalty_stamps SET reward_id=NULL WHERE reward_id=$1',[rewardId]);
      await audit(db,b.tenant_id,actorId,'loyalty.revoked',rewardId,{bookingId:b.id});
      if (b.user_id) await notify(db,b.user_id,b.tenant_id,'loyalty.revoked',rewardId,'Награда отозвана','Салон исправил исход одного из зачтённых посещений. Остальные отметки сохранены.');
    }
    if (stamps.some(s=>s.active)) await db.query('UPDATE loyalty_stamps SET active=false WHERE booking_id=$1',[b.id]);
    return;
  }
  if (b.price_minor_snapshot-b.discount_minor<=0) return;
  const programs=await rows<Program>(db,
    "SELECT * FROM loyalty_programs WHERE tenant_id=$1 AND service_id=$2 AND enabled AND status='active' AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now()) ORDER BY id",
    [b.tenant_id,b.service_id]);
  for (const p of programs) {
    if (stamps.some(s=>s.program_id===p.id && s.active)) continue;
    if (p.issue_limit!==null && p.issued_total>=p.issue_limit) {
      await db.query("UPDATE loyalty_programs SET status='exhausted' WHERE id=$1",[p.id]);continue;
    }
    await db.query('INSERT INTO loyalty_stamps(booking_id,tenant_id,customer_id,program_id,active) VALUES($1,$2,$3,$4,true) ON CONFLICT(booking_id,program_id) DO UPDATE SET active=true',[b.id,b.tenant_id,b.customer_id,p.id]);
    const cycle=await rows<{booking_id:string}>(db,'SELECT booking_id FROM loyalty_stamps WHERE program_id=$1 AND customer_id=$2 AND active AND reward_id IS NULL ORDER BY created_at,booking_id LIMIT $3',[p.id,b.customer_id,p.visits_required]);
    if(cycle.length<p.visits_required)continue;
    const free=p.reward_type==='free_visits'?p.free_visits_count:null;
    const reward=required(await one<{id:string}>(db,
      "INSERT INTO loyalty_rewards(tenant_id,customer_id,program_id,service_id,service_name,visits_required,reward_type,fixed_discount_minor,discount_percent,free_visits_count,remaining_visits,expires_at,terms_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $12::int IS NULL THEN NULL ELSE now()+$12*interval '24 hours' END,$13) RETURNING id",
      [b.tenant_id,b.customer_id,p.id,b.service_id,b.service_name_snapshot,p.visits_required,p.reward_type,p.fixed_discount_minor,p.discount_percent,free,free??0,p.reward_valid_days,JSON.stringify({programId:p.id,visitsRequired:p.visits_required,rewardType:p.reward_type,fixedDiscountMinor:p.fixed_discount_minor,discountPercent:p.discount_percent,freeVisitsCount:free,rewardValidDays:p.reward_valid_days})]));
    await db.query('UPDATE loyalty_stamps SET reward_id=$1 WHERE program_id=$2 AND booking_id=ANY($3::uuid[])',[reward.id,p.id,cycle.map(s=>s.booking_id)]);
    await db.query("UPDATE loyalty_programs SET issued_total=issued_total+1,status=CASE WHEN issue_limit IS NOT NULL AND issued_total+1>=issue_limit THEN 'exhausted' ELSE status END WHERE id=$1",[p.id]);
    await audit(db,b.tenant_id,actorId,'loyalty.issued',reward.id,{bookingId:b.id,programId:p.id,visitsRequired:p.visits_required});
    if(b.user_id)await notify(db,b.user_id,b.tenant_id,'loyalty.issued',reward.id,'Вы получили награду',
      `${b.service_name_snapshot}: ${p.visits_required} посещений зачтены. Выберите награду при следующей записи.`);
  }
}

export async function loyaltyCards(
  db: DB,
  userId?: string,
  tenantId?: string,
  customerId?: string,
) {
  return rows(
    db,
    `SELECT p.*,s.name service_name,t.name tenant_name,t.public_code,c.id customer_id,
    (SELECT count(*)::int FROM loyalty_stamps ls WHERE ls.program_id=p.id AND ls.customer_id=c.id AND ls.active AND ls.reward_id IS NULL) progress,
    (SELECT count(*)::int FROM loyalty_rewards lr WHERE lr.program_id=p.id AND lr.customer_id=c.id AND lr.status='issued') available_rewards
    FROM loyalty_programs p JOIN tenants t ON t.id=p.tenant_id JOIN services s ON s.id=p.service_id
    LEFT JOIN customers c ON c.tenant_id=p.tenant_id AND ($1::uuid IS NULL OR c.user_id=$1) AND ($3::uuid IS NULL OR c.id=$3)
    WHERE ($2::uuid IS NULL OR p.tenant_id=$2) AND ($1::uuid IS NULL OR t.status='published' OR c.id IS NOT NULL)
    ORDER BY t.name,s.name`,
    [userId ?? null, tenantId ?? null, customerId ?? null],
  );
}
