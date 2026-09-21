import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { config } from '../../packages/backend/config.js';
import { pool,one } from '../../packages/db/db.js';
import { identityRoutes } from '../../packages/backend/identity.routes.js';
import { salonRoutes } from '../../packages/backend/salons.routes.js';
import { bookingRoutes } from '../../packages/backend/bookings.routes.js';
import { crmRoutes } from '../../packages/backend/crm.routes.js';
import { partnerRoutes } from '../../packages/backend/partners.routes.js';
import { loyaltyRoutes } from '../../packages/backend/loyalty.routes.js';
import { analyticsRoutes } from '../../packages/backend/analytics.routes.js';
import { canonical,equalSecret,hash } from '../../packages/backend/auth.js';
import { endpoints } from '../../packages/backend/http.js';
import { z } from 'zod';

@Module({}) class AppModule {}
export async function createApp(){
  const adapter=new FastifyAdapter({bodyLimit:32768,logger: {level:'info',redact:['req.headers.authorization','req.headers.x-max-bot-api-secret']},disableRequestLogging:true});
  const app=await NestFactory.create<NestFastifyApplication>(AppModule,adapter,{logger:['error','warn']});
  const server=app.getHttpAdapter().getInstance() as FastifyInstance;
  await server.register(multipart,{limits:{fileSize:5*1024*1024,files:1,fields:2}});
  await server.register(rateLimit,{max:config.APP_ENV==='test'?100000:180,timeWindow:'1 minute',errorResponseBuilder:()=>({error:{code:'RATE_LIMITED',message:'Слишком много запросов. Повторите через минуту.'}})});
  server.addHook('onSend',async(_request,reply,payload)=>{reply.header('X-Content-Type-Options','nosniff').header('Cache-Control','no-store');return payload;});
  server.get('/health/live',async()=>({status:'ok'}));
  server.get('/health/ready',async(_request,reply)=>{try{await pool.query('SELECT 1 FROM schema_migrations LIMIT 1');const worker=await one<{updated_at:Date;value:unknown}>(pool,"SELECT * FROM system_state WHERE key='worker'");return {status:'ok',database:'ready',worker:worker?{lastHeartbeat:worker.updated_at,state:worker.value}:'not-started'};}catch{reply.code(503);return {status:'unavailable'};}});
  server.post('/integrations/max/webhook',async(request,reply)=>{
    if(!equalSecret(String(request.headers['x-max-bot-api-secret']??''),config.MAX_WEBHOOK_SECRET))return reply.code(403).send({error:'FORBIDDEN'});
    const parsed=z.object({update_type:z.string().max(100),timestamp:z.number().int().optional(),user:z.unknown().optional(),message:z.unknown().optional()}).passthrough().safeParse(request.body);
    if(!parsed.success)return reply.code(422).send({error:'INVALID_UPDATE'});
    try{await pool.query('INSERT INTO max_inbox(event_key,payload) VALUES($1,$2) ON CONFLICT DO NOTHING',[hash(canonical(parsed.data)),JSON.stringify(parsed.data)]);return {ok:true};}catch{return reply.code(503).send({error:'DATABASE_UNAVAILABLE'});}
  });
  identityRoutes(server);salonRoutes(server);bookingRoutes(server);crmRoutes(server);partnerRoutes(server);analyticsRoutes(server);loyaltyRoutes(server);
  server.get('/api/openapi.json',async()=>{
    const paths:Record<string,Record<string,unknown>>={};
    for(const e of endpoints){const path=e.path.replace(/:([A-Za-z]+)/g,'{$1}');paths[path]??={};paths[path]![e.method.toLowerCase()]={summary:e.description,security:e.scope==='public'?[]:[{bearer:[]}],parameters:[...[...e.path.matchAll(/:([A-Za-z]+)/g)].map(m=>({name:m[1],in:'path',required:true,schema:{type:'string'}})),...(e.requiresIdempotency?[{name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',format:'uuid'}}]:[])],...(e.schema?{requestBody:{required:true,content:{'application/json':{schema:z.toJSONSchema(e.schema,{unrepresentable:'any',io:'input'})}}}}:{}),responses:{200:{description:'Успешный результат в data/meta'},201:{description:'Команда выполнена'},401:{description:'Требуется MAX вход'},403:{description:'Недостаточно прав'},404:{description:'Объект недоступен'},409:{description:'Конфликт или требуется подтверждение'},422:{description:'Ошибка входных данных'}}};}
    return {openapi:'3.1.0',info:{title:'Салоны в MAX',version:'1.0.0'},components:{securitySchemes:{bearer:{type:'http',scheme:'bearer'}}},paths};
  });
  await app.init();return app;
}
if(!process.env.VITEST){const app=await createApp();await app.listen(config.PORT,'0.0.0.0');for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await app.close();await pool.end();process.exit(0);});}
