import { one, rows, type DB } from '../db/db.js';
import { fail, required } from './errors.js';
import { audit } from './http.js';
import { notify } from './notifications.js';
import type { Booking } from './types.js';

interface Program {id:string;tenant_id:string;service_id:string;visits_required:number;enabled:boolean;version:number;}
interface Reward {id:string;status:string;reserved_booking_id:string|null;redeemed_booking_id:string|null;service_id:string;}

export async function checkReward(db:DB,id:string,tenantId:string,customerId:string,serviceId:string,bookingId?:string) {
  const reward=required(await one<Reward>(db,'SELECT * FROM loyalty_rewards WHERE id=$1 AND tenant_id=$2 AND customer_id=$3',[id,tenantId,customerId]));
  if(reward.service_id!==serviceId || !(reward.status==='issued'||reward.status==='reserved'&&reward.reserved_booking_id===bookingId))
    fail(409,'LOYALTY_REWARD_UNAVAILABLE','Бесплатный визит уже использован, зарезервирован или относится к другой услуге.');
  return reward;
}

// All calls run inside the shared transactional write gate used by booking commands.
export async function loyaltyOutcome(db:DB,b:Booking,target:string,actorId:string) {
  if(b.loyalty_reward_id) {
    const reward=required(await one<Reward>(db,'SELECT * FROM loyalty_rewards WHERE id=$1 AND tenant_id=$2 AND customer_id=$3',[b.loyalty_reward_id,b.tenant_id,b.customer_id]));
    if(target==='completed') {
      if(reward.status==='redeemed'&&reward.redeemed_booking_id===b.id)return;
      await checkReward(db,reward.id,b.tenant_id,b.customer_id,b.service_id,b.id);
      await db.query("UPDATE loyalty_rewards SET status='redeemed',reserved_booking_id=NULL,redeemed_booking_id=$2 WHERE id=$1",[reward.id,b.id]);
      await audit(db,b.tenant_id,actorId,'loyalty.redeemed',reward.id,{bookingId:b.id});
    } else if(reward.status==='reserved'&&reward.reserved_booking_id===b.id) {
      await db.query("UPDATE loyalty_rewards SET status='issued',reserved_booking_id=NULL WHERE id=$1",[reward.id]);
      await audit(db,b.tenant_id,actorId,'loyalty.released',reward.id,{bookingId:b.id});
    }
    // A consumed reward stays consumed even after an outcome correction.
    return;
  }
  const stamp=await one<{reward_id:string|null;active:boolean}>(db,'SELECT * FROM loyalty_stamps WHERE booking_id=$1',[b.id]);
  if(target!=='completed') {
    if(!stamp?.active)return;
    if(stamp.reward_id) {
      const reward=required(await one<Reward>(db,'SELECT * FROM loyalty_rewards WHERE id=$1',[stamp.reward_id]));
      if(['reserved','redeemed'].includes(reward.status))fail(409,'LOYALTY_REVIEW_REQUIRED','Этот визит дал награду, которая уже занята записью или использована. Сначала разберите связанный бесплатный визит.');
      await db.query("UPDATE loyalty_rewards SET status='revoked' WHERE id=$1",[reward.id]);
      await db.query('UPDATE loyalty_stamps SET reward_id=NULL WHERE reward_id=$1',[reward.id]);
      await audit(db,b.tenant_id,actorId,'loyalty.revoked',reward.id,{bookingId:b.id});
      if(b.user_id)await notify(db,b.user_id,b.tenant_id,'loyalty.revoked',reward.id,'Бесплатный визит отозван','Салон исправил исход одного из зачтённых посещений. Остальные отметки сохранены.');
    }
    await db.query('UPDATE loyalty_stamps SET active=false WHERE booking_id=$1',[b.id]);
    return;
  }
  if(b.price_minor_snapshot-b.discount_minor<=0 || stamp?.active)return;
  const p=await one<Program>(db,'SELECT * FROM loyalty_programs WHERE tenant_id=$1 AND service_id=$2 AND enabled',[b.tenant_id,b.service_id]);
  if(!p)return;
  await db.query('INSERT INTO loyalty_stamps(booking_id,tenant_id,customer_id,program_id) VALUES($1,$2,$3,$4) ON CONFLICT(booking_id) DO UPDATE SET active=true',[b.id,b.tenant_id,b.customer_id,p.id]);
  const stamps=await rows<{booking_id:string}>(db,'SELECT booking_id FROM loyalty_stamps WHERE program_id=$1 AND customer_id=$2 AND active AND reward_id IS NULL ORDER BY created_at,booking_id LIMIT $3',[p.id,b.customer_id,p.visits_required]);
  if(stamps.length<p.visits_required)return;
  const reward=required(await one<{id:string}>(db,'INSERT INTO loyalty_rewards(tenant_id,customer_id,program_id,service_id,service_name,visits_required) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[b.tenant_id,b.customer_id,p.id,b.service_id,b.service_name_snapshot,p.visits_required]));
  await db.query('UPDATE loyalty_stamps SET reward_id=$1 WHERE booking_id=ANY($2::uuid[])',[reward.id,stamps.map(s=>s.booking_id)]);
  await audit(db,b.tenant_id,actorId,'loyalty.issued',reward.id,{bookingId:b.id,visitsRequired:p.visits_required});
  if(b.user_id)await notify(db,b.user_id,b.tenant_id,'loyalty.issued',reward.id,'Вы получили бесплатный визит',`${b.service_name_snapshot}: ${p.visits_required} посещений зачтены. Выберите бесплатный визит при следующей записи.`);
}

export async function loyaltyCards(db:DB,userId?:string,tenantId?:string,customerId?:string) {
  return rows(db,`SELECT p.*,s.name service_name,t.name tenant_name,t.public_code,c.id customer_id,
    (SELECT count(*)::int FROM loyalty_stamps ls WHERE ls.program_id=p.id AND ls.customer_id=c.id AND ls.active AND ls.reward_id IS NULL) progress,
    (SELECT count(*)::int FROM loyalty_rewards lr WHERE lr.program_id=p.id AND lr.customer_id=c.id AND lr.status='issued') available_rewards
    FROM loyalty_programs p JOIN tenants t ON t.id=p.tenant_id JOIN services s ON s.id=p.service_id
    LEFT JOIN customers c ON c.tenant_id=p.tenant_id AND ($1::uuid IS NULL OR c.user_id=$1) AND ($3::uuid IS NULL OR c.id=$3)
    WHERE ($2::uuid IS NULL OR p.tenant_id=$2) AND ($1::uuid IS NULL OR t.status='published' OR c.id IS NOT NULL)
    ORDER BY t.name,s.name`,[userId??null,tenantId??null,customerId??null]);
}
