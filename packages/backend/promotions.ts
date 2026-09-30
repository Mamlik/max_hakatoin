import { one, rows, type DB } from '../db/db.js';
import { required, fail } from './errors.js';
import { benefitDiscount } from './benefits.js';

export interface PromotionVersion {
  id:string; promotion_id:string; provider_tenant_id:string; proposer_tenant_id:string;
  status:string; service_ids:string[]; discount_type:'fixed'|'percent';
  fixed_discount_minor:number|null; discount_percent:number|null; starts_at:Date; ends_at:Date;
  use_limit:number|null; used_total:number; title:string; terms_text:string;
}
export async function promotionCheck(db:DB,id:string,tenantId:string,serviceId:string,startAt:string,existingBooking?:string){
  const v=required(await one<PromotionVersion>(db,
    "SELECT v.*,p.provider_tenant_id,p.proposer_tenant_id FROM promotion_versions v JOIN promotions p ON p.id=v.promotion_id JOIN tenants provider ON provider.id=p.provider_tenant_id JOIN tenants proposer ON proposer.id=p.proposer_tenant_id WHERE v.id=$1 AND p.provider_tenant_id=$2 AND p.active_version_id=v.id AND p.status='active' AND provider.status='published' AND proposer.status='published' AND (p.provider_tenant_id=p.proposer_tenant_id OR (provider.partner_enabled AND proposer.partner_enabled)) AND NOT EXISTS(SELECT 1 FROM promotion_pauses q WHERE q.promotion_id=p.id)",[id,tenantId]));
  const start=new Date(startAt);
  if(!v.service_ids.includes(serviceId)||start<v.starts_at||start>=v.ends_at||new Date()>=v.ends_at)
    fail(409,'PROMOTION_UNAVAILABLE','Акция недоступна для этой услуги и времени');
  const used=await one<{count:number}>(db,"SELECT count(*)::int count FROM promotion_reservations WHERE version_id=$1 AND status='reserved' AND booking_id<>COALESCE($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid)",[id,existingBooking??null]);
  if(v.use_limit!==null&&v.used_total+(used?.count??0)>=v.use_limit)
    fail(409,'PROMOTION_EXHAUSTED','Лимит акции исчерпан');
  return v;
}
export function promotionDiscount(v:PromotionVersion,price:number){return benefitDiscount(price,v.discount_type,v.fixed_discount_minor,v.discount_percent);}
export async function reservePromotion(db:DB,bookingId:string,versionId:string){
  await db.query("INSERT INTO promotion_reservations(booking_id,version_id,status) VALUES($1,$2,'reserved') ON CONFLICT(booking_id) DO UPDATE SET version_id=$2,status='reserved'",[bookingId,versionId]);
}
export async function promotionOutcome(db:DB,bookingId:string,target:string){
  const r=await one<{version_id:string;status:string}>(db,'SELECT * FROM promotion_reservations WHERE booking_id=$1',[bookingId]);
  if(!r)return;
  if(target==='completed'&&r.status!=='used'){
    if(r.status==='released'){
      const capacity=required(await one<{use_limit:number|null;used_total:number;reserved:number}>(db,"SELECT v.use_limit,v.used_total,(SELECT count(*)::int FROM promotion_reservations r WHERE r.version_id=v.id AND r.status='reserved') reserved FROM promotion_versions v WHERE v.id=$1",[r.version_id]));
      if(capacity.use_limit!==null&&capacity.used_total+capacity.reserved>=capacity.use_limit)
        fail(409,'PROMOTION_EXHAUSTED','Лимит акции уже занят другой записью. Исправление требует разбора скидки.');
    }
    await db.query("UPDATE promotion_reservations SET status='used' WHERE booking_id=$1",[bookingId]);
    await db.query('UPDATE promotion_versions SET used_total=used_total+1 WHERE id=$1',[r.version_id]);
  }else if(target!=='completed'&&r.status==='reserved')
    await db.query("UPDATE promotion_reservations SET status='released' WHERE booking_id=$1",[bookingId]);
  else if(target!=='completed'&&r.status==='used'){
    await db.query("UPDATE promotion_reservations SET status='released' WHERE booking_id=$1",[bookingId]);
    await db.query('UPDATE promotion_versions SET used_total=used_total-1 WHERE id=$1 AND used_total>0',[r.version_id]);
  }
}
