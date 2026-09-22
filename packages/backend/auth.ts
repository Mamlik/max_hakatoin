import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { parse as parseLossless, isLosslessNumber } from "lossless-json";
import { config } from "./config.js";
import { fail, required } from "./errors.js";
import { one, type DB } from "../db/db.js";
import type { Actor, Membership, Role } from "./types.js";

export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);

    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

export function equalSecret(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function signInitData(
  values: Record<string, string>,
  token = config.MAX_BOT_TOKEN,
) {
  const params = new URLSearchParams(values);
  const text = [...params.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(text).digest("hex"));
  return params.toString();
}
export function validateInitData(
  raw: string,
  token = config.MAX_BOT_TOKEN,
  now = Date.now(),
) {
  if (Buffer.byteLength(raw) > 16384)
    fail(401, "AUTH_REQUIRED", "Недопустимые данные MAX");
  const p = new URLSearchParams(raw);
  if (new Set([...p.keys()]).size !== [...p.keys()].length)
    fail(401, "AUTH_REQUIRED", "Повторяющиеся параметры MAX");
  const signature = p.get("hash") ?? "";
  const date = p.get("auth_date") ?? "";
  if (
    !/^[0-9a-fA-F]{64}$/.test(signature) ||
    !/^\d{10}$/.test(date) ||
    !p.get("user")
  )
    fail(401, "AUTH_REQUIRED", "Некорректные данные MAX");
  p.delete("hash");
  const text = [...p.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  if (
    !timingSafeEqual(
      Buffer.from(signature, "hex"),
      createHmac("sha256", secret).update(text).digest(),
    )
  )
    fail(401, "AUTH_REQUIRED", "Подпись MAX не подтверждена");
  const authDate = Number(date) * 1000;
  if (
    now - authDate >= config.AUTH_MAX_AGE_SECONDS * 1000 ||
    authDate - now > config.AUTH_FUTURE_SKEW_SECONDS * 1000
  )
    fail(401, "AUTH_REQUIRED", "Откройте приложение заново в MAX");
  let user: Record<string, unknown>;
  try {
    user = parseLossless(p.get("user")!) as Record<string, unknown>;
  } catch {
    return fail(401, "AUTH_REQUIRED", "Некорректный профиль MAX");
  }
  if (!user || typeof user !== "object")
    fail(401, "AUTH_REQUIRED", "Некорректный профиль MAX");
  const id = isLosslessNumber(user.id) ? user.id.toString() : String(user.id);
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n)
    fail(401, "AUTH_REQUIRED", "Некорректный идентификатор MAX");
  const name =
    [user.first_name, user.last_name]
      .filter((v) => typeof v === "string")
      .join(" ")
      .trim()
      .slice(0, 120) || "Пользователь MAX";
  return {
    id,
    name,
    expiresAt: new Date(authDate + config.AUTH_MAX_AGE_SECONDS * 1000),
    startParam: p.get("start_param") ?? null,
  };
}
export async function authenticate(
  db: DB,
  authorization?: string,
): Promise<Actor> {
  if (!authorization?.startsWith("Bearer "))
    fail(401, "AUTH_REQUIRED", "Войдите через MAX");
  const actor = await one<
    Actor & { session_expires_at: Date; session_created_at: Date }
  >(
    db,
    "SELECT u.*, s.id session_id, s.expires_at session_expires_at, s.created_at session_created_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()",
    [hash(authorization.slice(7))],
  );
  if (!actor) {
    fail(
      401,
      "AUTH_REQUIRED",
      "Сессия истекла. Откройте приложение заново в MAX",
    );
  }
  // Sliding window: staff working a shift are not logged out mid-task. The write happens
  // at most once per half window, and never extends past created_at + SESSION_ABSOLUTE_SECONDS.
  const absoluteEnd =
    actor.session_created_at.getTime() + config.SESSION_ABSOLUTE_SECONDS * 1000;
  if (
    actor.session_expires_at.getTime() < absoluteEnd &&
    actor.session_expires_at.getTime() - Date.now() <
      config.SESSION_IDLE_SECONDS * 500
  )
    await db.query(
      "UPDATE sessions SET expires_at=LEAST(now()+make_interval(secs=>$2::int), created_at+make_interval(secs=>$3::int)) WHERE id=$1",
      [
        actor.session_id,
        config.SESSION_IDLE_SECONDS,
        config.SESSION_ABSOLUTE_SECONDS,
      ],
    );

  return actor;
}
export async function access(
  db: DB,
  actor: Actor,
  tenant: string,
  roles: Role[] = ["owner", "admin", "master"],
): Promise<Membership> {
  const member = required(
    await one<Membership>(
      db,
      "SELECT * FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
      [tenant, actor.id],
    ),
  );

  if (!roles.includes(member.role)) {
    fail(403, "FORBIDDEN", "Для этого действия недостаточно прав");
  }

  return member;
}
