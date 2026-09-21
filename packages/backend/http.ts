import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply, HTTPMethods } from 'fastify';
import { pool, tx, one, camel, type DB } from '../db/db.js';
import { authenticate, access, canonical, hash } from './auth.js';
import { AppError, fail } from './errors.js';
import type { Actor, Membership, Role } from './types.js';

export interface Context<B = never> { db: DB; actor: Actor; member: Membership; p: Record<string,string>; q: Record<string,string>; b: B; request: FastifyRequest; reply: FastifyReply; }
export interface Endpoint { method: HTTPMethods; path: string; scope: string; successStatus:number; requiresIdempotency:boolean; schema?: z.ZodType; description: string; }
export const endpoints: Endpoint[] = [];
export function route<B>(app: FastifyInstance, method: HTTPMethods, path: string, options: { public?: boolean; roles?: Role[]; schema?: z.ZodType<B>; description: string; raw?: boolean; noIdempotency?: boolean }, handler: (ctx: Context<B>) => Promise<unknown>) {
  endpoints.push({method,path,scope:options.public?'public':options.roles?.join(',')??'user',requiresIdempotency:!['GET','HEAD'].includes(method)&&!options.public&&!options.noIdempotency,successStatus:method==='POST'&&!options.public&&!options.noIdempotency?201:200,schema:options.schema,description:options.description});
  app.route({method,url:path,handler:async(request, reply) => {
    const requestId = randomUUID(); reply.header('X-Request-Id',requestId);
    const envelope = (data: unknown) => ({data:camel(data),meta:{requestId,serverTime:new Date().toISOString()}});
    try {
      const p = (request.params ?? {}) as Record<string,string>; const q = (request.query ?? {}) as Record<string,string>;
      // Every internal path identifier is a UUID. Public codes, dates and action names are deliberately excluded.
      for (const key of ['t','b','c','id','v','staffId']) if (p[key] && !z.uuid().safeParse(p[key]).success) fail(404,'NOT_FOUND','Объект не найден');
      const body = options.schema ? options.schema.parse(request.body ?? {}) : request.body as B;
      const mutation = method !== 'GET' && method !== 'HEAD';
      const execute = async(db: DB) => {
        const actor = options.public ? undefined : await authenticate(db, request.headers.authorization);
        const member = options.roles ? await access(db, actor!, p.t!, options.roles) : undefined;
        const context = {db,actor:actor!,member:member!,p,q,b:body,request,reply};
        if (!mutation || options.public || options.noIdempotency) return {status:200,data:await handler(context)};
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string' || !z.uuid({version:'v4'}).safeParse(key).success) fail(422,'VALIDATION_ERROR','Нужен Idempotency-Key в формате UUID v4');
        const scope = p.t ? `tenant:${p.t}` : `user:${actor!.id}`;
        const operation = `${method}:${request.url.split('?')[0]}`; const fingerprint = hash(canonical(body));
        const old = await one<{fingerprint:string;status_code:number;result:unknown;created_at:Date}>(db,'SELECT * FROM operations WHERE actor_id=$1 AND scope=$2 AND operation=$3 AND key=$4',[actor!.id,scope,operation,key]);
        if (old) {
          if (old.fingerprint !== fingerprint) fail(409,'IDEMPOTENCY_KEY_REUSED','Этот ключ уже использован для другого действия');
          if (Date.now()-old.created_at.getTime()>86400000) fail(409,'IDEMPOTENCY_RESULT_EXPIRED','Результат операции устарел. Обновите данные.');
          return {status:old.status_code,data:old.result};
        }
        await db.query('SAVEPOINT business_command');
        let result: unknown; let status=method==='POST'?201:200;
        try { result = await handler(context); } catch(e) {
          await db.query('ROLLBACK TO SAVEPOINT business_command');
          if (!(e instanceof AppError) || e.status>=500) throw e;
          status=e.status; result={error:{code:e.code,message:e.message,details:e.details}};
        }
        await db.query('INSERT INTO operations(actor_id,scope,operation,key,fingerprint,status_code,result) VALUES($1,$2,$3,$4,$5,$6,$7)',[actor!.id,scope,operation,key,fingerprint,status,JSON.stringify(result??null)]);
        return {status,data:result};
      };
      const result = mutation ? await tx(async db=> {
        // A single short write gate makes all cross-tenant coupon/booking changes serializable.
        // No network I/O is performed under this gate. Reads remain concurrent.
        await db.query('SELECT pg_advisory_xact_lock(724992)'); return execute(db);
      }) : await execute(pool);
      if (options.raw) return;
      reply.code(result.status);
      return result.status>=400 ? {...result.data as object,meta:{requestId}} : envelope(result.data);
    } catch(e) {
      const sqlCode = e && typeof e==='object' && 'code' in e ? String(e.code) : '';
      let error = e instanceof AppError ? e : e instanceof z.ZodError ? new AppError(422,'VALIDATION_ERROR','Проверьте поля формы',{fields:e.issues.map(i=>({path:i.path,message:i.message}))}) : sqlCode==='23P01' ? new AppError(409,'SLOT_UNAVAILABLE','Это время уже занято. Выберите другое.') : sqlCode==='23503' ? new AppError(404,'NOT_FOUND','Связанный объект недоступен') : sqlCode==='23505' ? new AppError(409,'CONFLICT','Объект уже существует') : new AppError(503,'TEMPORARILY_UNAVAILABLE','Сервис временно недоступен. Повторите запрос с тем же ключом.');
      if (error.status>=500) request.log.error({requestId,errorType:e instanceof Error?e.name:'unknown',sqlCode},'Request failed');
      reply.code(error.status); return {error:{code:error.code,message:error.message,details:error.details},meta:{requestId}};
    }
  }});
}
export async function audit(db: DB, tenantId: string | null, actorId: string, action: string, objectId: string | null, details: Record<string,unknown>={}) { await db.query('INSERT INTO audit_log(tenant_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5)',[tenantId,actorId,action,objectId,JSON.stringify(details)]); }
export function list<T>(items: T[], limit=100) { return {items:items.slice(0,limit),nextCursor:items.length>limit?String(limit):null}; }
export function page(q: Record<string,string>) { const limit=Math.min(100,Math.max(1,Number(q.limit)||30)); const offset=Math.max(0,Number(q.cursor)||0); return {limit,offset}; }
