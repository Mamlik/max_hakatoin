import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {one,rows} from '../db/db.js';
import {route,list,audit} from './http.js';
import {required,fail,version} from './errors.js';
import {canonical,hash} from './auth.js';

const terms=z.object({
  providerTenantId:z.uuid(), title:z.string().trim().min(1).max(120),
  termsText:z.string().trim().min(3).max(1000),
  serviceIds:z.array(z.uuid()).min(1).max(100),
  discountType:z.enum(['fixed','percent']),
  fixedDiscountMinor:z.number().int().positive().nullable(),
  discountPercent:z.number().int().min(1).max(100).nullable(),
  startsAt:z.iso.datetime({offset:true}),endsAt:z.iso.datetime({offset:true}),
  useLimit:z.number().int().positive().nullable(),
}).strict().superRefine((v,ctx)=>{
  if(v.discountType==='fixed' ? v.fixedDiscountMinor===null||v.discountPercent!==null : v.discountPercent===null||v.fixedDiscountMinor!==null)
    ctx.addIssue({code:'custom',message:'Укажите один номинал скидки'});
  if(Date.parse(v.endsAt)<=Date.parse(v.startsAt))ctx.addIssue({code:'custom',message:'Некорректный период акции'});
});
type Terms=z.infer<typeof terms>;
async function validateServices(db:import('../db/db.js').DB,b:Terms){
  const services=await rows<{id:string}>(db,'SELECT id FROM services WHERE tenant_id=$1 AND active AND id=ANY($2::uuid[])',[b.providerTenantId,b.serviceIds]);
  if(services.length!==b.serviceIds.length || b.serviceIds.length!==new Set(b.serviceIds).size)fail(422,'VALIDATION_ERROR','Услуги акции должны быть уникальны и принадлежать салону-исполнителю');
}
async function visible(db:import('../db/db.js').DB,tenantId:string,id:string){return required(await one<{id:string;provider_tenant_id:string;proposer_tenant_id:string;active_version_id:string|null;pending_version_id:string|null;status:string;version:number}>(db,
  'SELECT * FROM promotions WHERE id=$1 AND (provider_tenant_id=$2 OR proposer_tenant_id=$2)',[id,tenantId]));}
async function insertVersion(db:import('../db/db.js').DB,promotionId:string,b:Terms,status:string){return required(await one<{id:string}>(db,
  "INSERT INTO promotion_versions(promotion_id,number,status,title,terms_text,service_ids,discount_type,fixed_discount_minor,discount_percent,starts_at,ends_at,use_limit,terms_hash) SELECT $1,COALESCE(max(number),0)+1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12 FROM promotion_versions WHERE promotion_id=$1 RETURNING id",
  [promotionId,status,b.title,b.termsText,b.serviceIds,b.discountType,b.fixedDiscountMinor,b.discountPercent,b.startsAt,b.endsAt,b.useLimit,hash(canonical(b))]));}
export function promotionRoutes(app:FastifyInstance){
  route(app,'GET','/api/v1/me/promotions',{description:'Доступные временные акции'},async({db})=>list(await rows(db,
    "SELECT v.*,p.provider_tenant_id,p.proposer_tenant_id,t.name provider_name,t.public_code FROM promotions p JOIN promotion_versions v ON v.id=p.active_version_id JOIN tenants t ON t.id=p.provider_tenant_id JOIN tenants proposer ON proposer.id=p.proposer_tenant_id WHERE p.status='active' AND t.status='published' AND proposer.status='published' AND (p.provider_tenant_id=p.proposer_tenant_id OR (t.partner_enabled AND proposer.partner_enabled)) AND v.ends_at>now() AND NOT EXISTS(SELECT 1 FROM promotion_pauses q WHERE q.promotion_id=p.id) ORDER BY v.ends_at",[]),1000));
  route(app,'GET','/api/v1/work/:t/promotions',{roles:['owner','admin'],description:'Акции салона'},async({db,p})=>list(await rows(db,
    "SELECT p.*,v.title,v.terms_text,v.service_ids,v.discount_type,v.fixed_discount_minor,v.discount_percent,v.starts_at,v.ends_at,v.use_limit,v.used_total,COALESCE((SELECT count(*)::int FROM promotion_reservations r WHERE r.version_id=p.active_version_id AND r.status='reserved'),0) reserved_total,EXISTS(SELECT 1 FROM promotion_acceptances a WHERE a.version_id=p.pending_version_id AND a.tenant_id=$1) accepted_by_me FROM promotions p LEFT JOIN promotion_versions v ON v.id=COALESCE(p.pending_version_id,p.active_version_id) WHERE p.provider_tenant_id=$1 OR p.proposer_tenant_id=$1 ORDER BY p.created_at DESC",[p.t]),1000));
  route(app,'GET','/api/v1/work/:t/promotions/:id',{roles:['owner','admin'],description:'Версии и паузы акции'},async({db,p})=>{
    const promotion=await visible(db,p.t!,p.id!);return {promotion,versions:await rows(db,'SELECT * FROM promotion_versions WHERE promotion_id=$1 ORDER BY number DESC',[p.id]),pauses:await rows(db,'SELECT * FROM promotion_pauses WHERE promotion_id=$1',[p.id])};
  });
  route(app,'POST','/api/v1/work/:t/promotions',{roles:['owner'],description:'Опубликовать свою акцию или предложить партнёру',schema:terms},async({db,p,b,actor})=>{
    await validateServices(db,b);
    if(b.providerTenantId!==p.t){
      const both=await rows(db,"SELECT id FROM tenants WHERE id=ANY($1::uuid[]) AND status='published' AND partner_enabled",[[b.providerTenantId,p.t]]);
      if(both.length!==2)fail(409,'TENANT_UNAVAILABLE','Оба салона должны включить партнёрство');
    }
    const self=b.providerTenantId===p.t;
    const promotion=required(await one<{id:string}>(db,"INSERT INTO promotions(provider_tenant_id,proposer_tenant_id,status) VALUES($1,$2,$3) RETURNING id",[b.providerTenantId,p.t,self?'active':'proposed']));
    const v=await insertVersion(db,promotion.id,b,self?'active':'proposed');
    await db.query(`UPDATE promotions SET ${self?'active_version_id':'pending_version_id'}=$2 WHERE id=$1`,[promotion.id,v.id]);
    await db.query('INSERT INTO promotion_acceptances(version_id,tenant_id,user_id,terms_hash) SELECT id,$2,$3,terms_hash FROM promotion_versions WHERE id=$1',[v.id,p.t,actor.id]);
    await audit(db,p.t!,actor.id,self?'promotion.published':'promotion.proposed',promotion.id,{versionId:v.id});return visible(db,p.t!,promotion.id);
  });
  route(app,'POST','/api/v1/work/:t/promotions/:id/versions',{roles:['owner'],description:'Предложить новую версию акции',schema:terms.safeExtend({expectedVersion:z.number().int().positive()})},async({db,p,b,actor})=>{
    const promotion=await visible(db,p.t!,p.id!);version(promotion,b.expectedVersion);
    if(promotion.status==='ended'||promotion.pending_version_id||promotion.provider_tenant_id!==b.providerTenantId)fail(409,'INVALID_STATE_TRANSITION','Новую версию сейчас предложить нельзя');
    await validateServices(db,b);
    const self=promotion.provider_tenant_id===promotion.proposer_tenant_id;
    const v=await insertVersion(db,promotion.id,b,self?'active':'proposed');
    if(self){await db.query("UPDATE promotion_versions SET status='ended' WHERE id=$1",[promotion.active_version_id]);await db.query("UPDATE promotions SET active_version_id=$2,version=version+1 WHERE id=$1",[promotion.id,v.id]);}
    else{await db.query('UPDATE promotions SET pending_version_id=$2,version=version+1 WHERE id=$1',[promotion.id,v.id]);}
    await db.query('INSERT INTO promotion_acceptances(version_id,tenant_id,user_id,terms_hash) SELECT id,$2,$3,terms_hash FROM promotion_versions WHERE id=$1',[v.id,p.t,actor.id]);
    await audit(db,p.t!,actor.id,self?'promotion.version_published':'promotion.version_proposed',promotion.id,{versionId:v.id});return visible(db,p.t!,promotion.id);
  });
  for(const action of ['accept','reject','pause','resume','end'] as const)route(app,'POST',`/api/v1/work/:t/promotions/:id/${action}`,{
    roles:['owner'],description:`${action} акцию`,schema:z.object({expectedVersion:z.number().int().positive(),reason:z.string().max(500).optional()}).strict(),
  },async({db,p,b,actor})=>{
    const promotion=await visible(db,p.t!,p.id!);version(promotion,b.expectedVersion);
    if(promotion.status==='ended')fail(409,'INVALID_STATE_TRANSITION','Акция завершена');
    if(action==='accept'||action==='reject'){
      if(!promotion.pending_version_id || await one(db,'SELECT 1 FROM promotion_acceptances WHERE version_id=$1 AND tenant_id=$2',[promotion.pending_version_id,p.t]))fail(409,'INVALID_STATE_TRANSITION','Нет нового предложения для вашей стороны');
      const v=promotion.pending_version_id;
      if(action==='accept'){
        const terms=required(await one<{service_ids:string[];starts_at:Date;ends_at:Date}>(db,'SELECT service_ids,starts_at,ends_at FROM promotion_versions WHERE id=$1',[v]));
        if(terms.ends_at<=new Date())fail(409,'PROMOTION_UNAVAILABLE','Срок акции уже закончился');
        const services=await rows(db,'SELECT id FROM services WHERE tenant_id=$1 AND active AND id=ANY($2::uuid[])',[promotion.provider_tenant_id,terms.service_ids]);
        if(services.length!==terms.service_ids.length)fail(409,'PROMOTION_UNAVAILABLE','Состав услуг изменился');
        await db.query('INSERT INTO promotion_acceptances(version_id,tenant_id,user_id,terms_hash) SELECT id,$2,$3,terms_hash FROM promotion_versions WHERE id=$1',[v,p.t,actor.id]);
        const approvals=await rows(db,'SELECT tenant_id FROM promotion_acceptances WHERE version_id=$1',[v]);
        if(approvals.length!==2 || !approvals.some(a=>(a as {tenant_id:string}).tenant_id===promotion.provider_tenant_id))fail(409,'INVALID_STATE_TRANSITION','Обе стороны должны принять условия');
        if(promotion.active_version_id)await db.query("UPDATE promotion_versions SET status='ended' WHERE id=$1",[promotion.active_version_id]);
        await db.query("UPDATE promotion_versions SET status='active' WHERE id=$1",[v]);
        await db.query("UPDATE promotions SET active_version_id=$2,pending_version_id=NULL,status='active',version=version+1 WHERE id=$1",[promotion.id,v]);
      }else{
        await db.query("UPDATE promotion_versions SET status='rejected' WHERE id=$1",[v]);
        await db.query("UPDATE promotions SET pending_version_id=NULL,status=CASE WHEN active_version_id IS NULL THEN 'rejected' ELSE status END,version=version+1 WHERE id=$1",[promotion.id]);
      }
    }else if(action==='pause'){
      await db.query('INSERT INTO promotion_pauses(promotion_id,tenant_id,reason) VALUES($1,$2,$3) ON CONFLICT(promotion_id,tenant_id) DO UPDATE SET reason=$3',[promotion.id,p.t,b.reason??'Приостановлено']);
      await db.query('UPDATE promotions SET version=version+1 WHERE id=$1',[promotion.id]);
    }else if(action==='resume'){
      await db.query('DELETE FROM promotion_pauses WHERE promotion_id=$1 AND tenant_id=$2',[promotion.id,p.t]);
      await db.query('UPDATE promotions SET version=version+1 WHERE id=$1',[promotion.id]);
    }else{
      if(p.t!==promotion.provider_tenant_id)fail(403,'FORBIDDEN','Завершить акцию может салон-исполнитель');
      await db.query("UPDATE promotions SET status='ended',pending_version_id=NULL,version=version+1 WHERE id=$1",[promotion.id]);
    }
    await audit(db,p.t!,actor.id,`promotion.${action}`,promotion.id,{reason:b.reason});return visible(db,p.t!,promotion.id);
  });
}
