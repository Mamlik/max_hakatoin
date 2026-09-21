import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const secret = (name: string) => process.env[`${name}_FILE`] ? readFileSync(process.env[`${name}_FILE`]!, 'utf8').trim() : process.env[name];
const env = z.object({
  APP_ENV: z.enum(['local', 'demo', 'test', 'staging', 'production']).default('demo'),
  MAX_MODE: z.enum(['mock', 'real']).default('mock'),
  PORT: z.coerce.number().int().default(3100),
  PUBLIC_APP_URL: z.string().url().default('http://localhost:8080'),
  DATABASE_URL: z.string().default('postgres://salon:salon_local_only@localhost:5432/salon'),
  REDIS_URL: z.string().default('redis://localhost:6380'),
  MAX_BOT_TOKEN: z.string().min(16), MAX_WEBHOOK_SECRET: z.string().min(16),
  MAX_BOT_NAME: z.string().regex(/^[a-zA-Z0-9_]+$/).default('salons_demo_bot'),
  MAX_API_BASE_URL: z.string().url().default('https://platform-api2.max.ru'),
  MAX_GLOBAL_RPS: z.coerce.number().int().min(1).max(30).default(25),
  MAX_DIALOG_RPS: z.coerce.number().int().min(1).max(2).default(1),
  AUTH_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(3600).default(3600),
  AUTH_FUTURE_SKEW_SECONDS: z.coerce.number().int().min(0).max(60).default(60),
  MEDIA_ROOT: z.string().default('./media'),
  BOOKING_HORIZON_DAYS: z.coerce.number().int().min(1).max(30).default(30),
  SLOT_STEP_MINUTES: z.coerce.number().int().min(5).max(60).default(15),
}).parse({ ...process.env, MAX_BOT_TOKEN: secret('MAX_BOT_TOKEN') ?? 'demo-only-synthetic-token', MAX_WEBHOOK_SECRET: secret('MAX_WEBHOOK_SECRET') ?? 'demo-webhook-secret' });
if (['staging', 'production'].includes(env.APP_ENV)) {
  if (env.MAX_MODE !== 'real' || env.MAX_BOT_TOKEN.startsWith('demo') || env.MAX_WEBHOOK_SECRET.startsWith('demo')) throw new Error('Real MAX secrets are required in staging/production');
  if (!env.PUBLIC_APP_URL.startsWith('https://')) throw new Error('HTTPS PUBLIC_APP_URL required');
  if (env.MAX_API_BASE_URL !== 'https://platform-api2.max.ru') throw new Error('MAX API host is not allowed');
}
if (env.MAX_MODE === 'real' && env.MAX_BOT_TOKEN.startsWith('demo')) throw new Error('Set MAX_BOT_TOKEN_FILE before enabling real MAX');
export const config = env;
