import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { config } from "../backend/config.js";
import { hash } from "../backend/auth.js";
import { parse as parseLossless } from "lossless-json";
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 500, 5000),
});
redis.on("error", () => {});
const namespace = `max:${hash(config.MAX_BOT_TOKEN).slice(0, 16)}`;
const limiter = `
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
local ready=redis.call('GET',KEYS[3])
if not ready then redis.call('SET',KEYS[3],now+1000);return 1000 end
if tonumber(ready)>now then return tonumber(ready)-now end
local cooldown=redis.call('GET',KEYS[4]);if cooldown and tonumber(cooldown)>now then return tonumber(cooldown)-now end
local limits={tonumber(ARGV[1]),tonumber(ARGV[2])}
for i=1,2 do if limits[i]>0 then
redis.call('ZREMRANGEBYSCORE',KEYS[i],'-inf',now-1000)
if redis.call('ZCARD',KEYS[i])>=limits[i] then local v=redis.call('ZRANGE',KEYS[i],0,0,'WITHSCORES');return math.max(1,tonumber(v[2])+1001-now) end
end end
for i=1,2 do if limits[i]>0 then redis.call('ZADD',KEYS[i],now,ARGV[3]);redis.call('PEXPIRE',KEYS[i],2000) end end
return 0`;
export class MaxError extends Error {
  constructor(
    public code: string,
    public retryAfterMs = 0,
    public permanent = false,
  ) {
    super(code);
  }
}

export async function acquire(dialog?: string): Promise<void> {
  if (redis.status === "wait") await redis.connect();

  const wait = Number(
    await redis.eval(
      limiter,
      4,
      `${namespace}:global`,
      `${namespace}:dialog:${dialog ?? "ops"}`,
      `${namespace}:ready`,
      `${namespace}:cooldown`,
      config.MAX_GLOBAL_RPS,
      dialog ? config.MAX_DIALOG_RPS : 0,
      randomUUID(),
    ),
  );

  if (wait > 0) throw new MaxError("RATE_LIMITED", wait);
}

export async function maxRequest(
  method: string,
  path: string,
  body?: unknown,
  userId?: string,
): Promise<Record<string, unknown>> {
  await acquire(userId);
  if (config.MAX_MODE === "mock") {
    if (path === "/me")
      return { user_id: "999000", username: config.MAX_BOT_NAME };
    if (path === "/subscriptions") return { subscriptions: [] };
    return { message: { body: { mid: `mock-${randomUUID()}` } } };
  }

  let response: Response;
  try {
    response = await fetch(`${config.MAX_API_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: config.MAX_BOT_TOKEN,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new MaxError("NETWORK_OR_TLS", 5000);
  }

  if (!response.ok) {
    let retryAfterMs = Number(response.headers.get("retry-after") ?? 0) * 1000;
    if (!Number.isFinite(retryAfterMs)) {
      retryAfterMs =
        Math.max(
          0,
          Date.parse(response.headers.get("retry-after") ?? "") - Date.now(),
        ) || 0;
    }

    if (response.status === 401) {
      await redis.set(
        `${namespace}:cooldown`,
        Date.now() + 300000,
        "PX",
        300000,
      );
      throw new MaxError("MAX_TOKEN_INVALID", 300000);
    }

    if (response.status === 429) {
      retryAfterMs = Math.max(1000, retryAfterMs);
      await redis.set(
        `${namespace}:cooldown`,
        Date.now() + retryAfterMs,
        "PX",
        retryAfterMs,
      );
      throw new MaxError("MAX_429", retryAfterMs);
    }

    const permanent =
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408;
    throw new MaxError(`MAX_HTTP_${response.status}`, retryAfterMs, permanent);
  }

  const raw = await response.text();
  try {
    return parseLossless(raw) as Record<string, unknown>;
  } catch {
    throw new MaxError("MAX_INVALID_RESPONSE");
  }
}

export async function sendMessage(
  userId: string,
  text: string,
  payload: string,
) {
  return maxRequest(
    "POST",
    `/messages?user_id=${encodeURIComponent(userId)}`,
    {
      text,
      attachments: [
        {
          type: "inline_keyboard",
          payload: {
            buttons: [
              [
                {
                  type: "link",
                  text: "Открыть приложение",
                  url: `https://max.ru/${config.MAX_BOT_NAME}?startapp=${payload}`,
                },
              ],
            ],
          },
        },
      ],
    },
    userId,
  );
}
