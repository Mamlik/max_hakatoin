import { one, rows, type DB } from '../db/db.js';
import type { Booking, Membership } from './types.js';

export async function notify(db: DB, userId: string, tenantId: string | null, kind: string, objectId: string | null, title: string, body: string, options: {category?:string;booking?:Booking;membershipId?:string;dueAt?:Date;notAfter?:Date}={}) {
  const n=(await one<{id:string}>(db,'INSERT INTO notifications(user_id,tenant_id,kind,object_id,title,body,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[userId,tenantId,kind,objectId,title,body,options.dueAt??new Date()]))!;
  const channel=await one<{generation:number}>(db,'SELECT generation FROM bot_channels WHERE user_id=$1',[userId]);
  const d=(await one<{id:string}>(db,'INSERT INTO deliveries(notification_id,user_id,tenant_id,booking_id,booking_version,category,membership_id,generation,due_at,not_after) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',[n.id,userId,tenantId,options.booking?.id??null,options.booking?.version??null,options.category??'service',options.membershipId??null,channel?.generation??0,options.dueAt??new Date(),options.notAfter??new Date(Date.now()+86400000)]))!;
  await db.query('INSERT INTO outbox(delivery_id) VALUES($1)',[d.id]);
}
export async function bookingEvent(db: DB, booking: Booking, kind: string) {
  await db.query("UPDATE deliveries SET state='suppressed',last_error='SUPERSEDED' WHERE booking_id=$1 AND state IN ('scheduled','retry_wait')",[booking.id]);
  const tenant=(await one<{name:string;operational_recipient_id:string}>(db,'SELECT name,operational_recipient_id FROM tenants WHERE id=$1',[booking.tenant_id]))!;
  const labels:Record<string,string>={created:'Запись подтверждена',rescheduled:'Запись перенесена',cancelled:'Запись отменена',completed:'Визит завершён',no_show:'Отмечена неявка',corrected:'Исход визита исправлен'};
  const title=labels[kind]??kind; const body=`${tenant.name}: ${booking.service_name_snapshot}`;
  const recipients=await rows<Membership>(db,"SELECT m.* FROM memberships m WHERE m.tenant_id=$1 AND m.status='active' AND (m.user_id=$2 OR m.id IN (SELECT membership_id FROM staff WHERE id=$3))",[booking.tenant_id,tenant.operational_recipient_id,booking.staff_id]);
  const seen=new Set<string>();
  if(booking.user_id) { seen.add(booking.user_id); await notify(db,booking.user_id,booking.tenant_id,`booking.${kind}`,booking.id,title,body,{booking,notAfter:new Date(kind==='created'||kind==='rescheduled'?Math.min(booking.start_at.getTime(),Date.now()+86400000):Date.now()+86400000)}); }
  for(const member of recipients) if(!seen.has(member.user_id)) { seen.add(member.user_id); await notify(db,member.user_id,booking.tenant_id,`booking.${kind}`,booking.id,title,body,{booking,category:'work',membershipId:member.id}); }
  if(booking.status==='confirmed'&&booking.user_id) for(const hours of [24,2]) {
    const dueAt=new Date(booking.start_at.getTime()-hours*3600000); if(dueAt.getTime()<=Date.now())continue;
    await notify(db,booking.user_id,booking.tenant_id,'booking.reminder',booking.id,`Напоминание за ${hours} ч`,body,{booking,category:'reminder',dueAt,notAfter:new Date(dueAt.getTime()+900000)});
  }
}
