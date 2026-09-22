import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { route, audit, list, page } from "./http.js";
import { one, rows } from "../db/db.js";
import { required, fail, version } from "./errors.js";
import { customer, expected, id, reason, empty } from "../contracts/schemas.js";
import { hash, randomToken } from "./auth.js";
import { config } from "./config.js";
import type { Customer, Membership, Staff, Booking } from "./types.js";
import { getBooking, bookingDTO } from "./bookings.routes.js";
import { notify } from "./notifications.js";

interface Invite {
  id: string;
  tenant_id: string;
  kind: string;
  role: "admin" | "master";
  staff_id: string | null;
  customer_id: string | null;
  expected_user_id: string | null;
  status: string;
  candidate_user_id: string | null;
  expires_at: Date;
  version: number;
}
const manage = ["owner", "admin"] as ("owner" | "admin")[];
export function crmRoutes(app: FastifyInstance) {
  route(
    app,
    "GET",
    "/api/v1/work/:t/customers",
    {
      roles: manage,
      description: "Поиск CRM своего салона по имени, контакту и тегу",
    },
    async ({ db, p, q }) => {
      const { limit, offset } = page(q);
      const result = await rows(
        db,
        "SELECT c.*,count(b.id) FILTER(WHERE b.status='completed') completed_visits,min(b.start_at) FILTER(WHERE b.status='completed') first_visit,max(b.start_at) FILTER(WHERE b.status='completed') last_visit FROM customers c LEFT JOIN bookings b ON b.customer_id=c.id WHERE c.tenant_id=$1 AND ($2='' OR c.display_name ILIKE '%'||$2||'%' OR c.contact ILIKE '%'||$2||'%') AND ($3='' OR $3=ANY(c.tags)) GROUP BY c.id ORDER BY c.display_name,c.id LIMIT $4 OFFSET $5",
        [p.t, (q.query ?? "").slice(0, 120), q.tag ?? "", limit + 1, offset],
      );
      return {
        items: result.slice(0, limit),
        nextCursor: result.length > limit ? String(offset + limit) : null,
      };
    },
  );
  route(
    app,
    "POST",
    "/api/v1/work/:t/customers",
    {
      roles: manage,
      schema: customer,
      description: "Создание ручной карточки без угадывания аккаунта",
    },
    async ({ db, actor, p, b }) => {
      const c = (await one<Customer>(
        db,
        "INSERT INTO customers(tenant_id,display_name,contact,tags) VALUES($1,$2,$3,$4) RETURNING *",
        [p.t, b.displayName, b.contact, b.tags],
      ))!;
      await audit(db, p.t!, actor.id, "crm.customer_created", c.id);
      return c;
    },
  );
  route(
    app,
    "GET",
    "/api/v1/work/:t/customers/:c",
    {
      roles: manage,
      description: "Карточка, заметки и локальная история клиента",
    },
    async ({ db, p }) => {
      const c = required(
        await one<Customer>(
          db,
          "SELECT * FROM customers WHERE id=$1 AND tenant_id=$2",
          [p.c, p.t],
        ),
      );
      return {
        ...c,
        notes: await rows(
          db,
          "SELECT n.*,u.display_name author_name FROM customer_notes n JOIN users u ON u.id=n.author_id WHERE n.customer_id=$1 ORDER BY n.created_at DESC",
          [c.id],
        ),
        bookings: await rows(
          db,
          "SELECT id,start_at,end_at,status,service_name_snapshot,price_minor_snapshot,discount_minor FROM bookings WHERE customer_id=$1 ORDER BY start_at DESC LIMIT 100",
          [c.id],
        ),
        linkInvites: await rows(
          db,
          "SELECT i.id,i.status,i.expires_at,i.version,u.display_name candidate_name FROM invites i LEFT JOIN users u ON u.id=i.candidate_user_id WHERE i.customer_id=$1 ORDER BY i.created_at DESC",
          [c.id],
        ),
      };
    },
  );
  route(
    app,
    "PATCH",
    "/api/v1/work/:t/customers/:c",
    {
      roles: manage,
      schema: customer
        .extend({ expectedVersion: z.number().int().positive() })
        .strict(),
      description: "Изменение локального имени, контакта и тегов",
    },
    async ({ db, actor, p, b }) => {
      version(
        required(
          await one<Customer>(
            db,
            "SELECT * FROM customers WHERE id=$1 AND tenant_id=$2",
            [p.c, p.t],
          ),
        ),
        b.expectedVersion,
      );
      await audit(db, p.t!, actor.id, "crm.customer_updated", p.c!);
      return one(
        db,
        "UPDATE customers SET display_name=$2,contact=$3,tags=$4,version=version+1 WHERE id=$1 RETURNING *",
        [p.c, b.displayName, b.contact, b.tags],
      );
    },
  );
  route(
    app,
    "POST",
    "/api/v1/work/:t/customers/:c/notes",
    {
      roles: manage,
      schema: z.object({ body: z.string().trim().min(1).max(5000) }).strict(),
      description: "Внутренняя заметка без отправки клиенту",
    },
    async ({ db, actor, p, b }) => {
      required(
        await one(db, "SELECT id FROM customers WHERE id=$1 AND tenant_id=$2", [
          p.c,
          p.t,
        ]),
      );
      const note = (await one<{ id: string }>(
        db,
        "INSERT INTO customer_notes(tenant_id,customer_id,body,author_id) VALUES($1,$2,$3,$4) RETURNING *",
        [p.t, p.c, b.body, actor.id],
      ))!;
      await audit(db, p.t!, actor.id, "crm.note_created", note.id);
      return note;
    },
  );
  route(
    app,
    "PATCH",
    "/api/v1/work/:t/customers/:c/notes/:id",
    {
      roles: manage,
      schema: expected
        .extend({ body: z.string().trim().min(1).max(5000) })
        .strict(),
      description: "Редактирование заметки с аудитом",
    },
    async ({ db, actor, p, b }) => {
      version(
        required(
          await one<{ version: number }>(
            db,
            "SELECT version FROM customer_notes WHERE id=$1 AND customer_id=$2 AND tenant_id=$3",
            [p.id, p.c, p.t],
          ),
        ),
        b.expectedVersion,
      );
      await audit(db, p.t!, actor.id, "crm.note_updated", p.id!, {
        previousVersion: b.expectedVersion,
      });
      return one(
        db,
        "UPDATE customer_notes SET body=$2,version=version+1 WHERE id=$1 RETURNING *",
        [p.id, b.body],
      );
    },
  );
  route(
    app,
    "GET",
    "/api/v1/work/:t/customers/:c/eligible-vouchers",
    {
      roles: manage,
      description: "Только купоны клиента для принимающего салона",
    },
    async ({ db, p }) => {
      const c = required(
        await one<Customer>(
          db,
          "SELECT * FROM customers WHERE id=$1 AND tenant_id=$2",
          [p.c, p.t],
        ),
      );
      return list(
        await rows(
          db,
          "SELECT id,discount_minor,target_service_ids,expires_at,terms_snapshot FROM vouchers WHERE user_id=$1 AND target_tenant_id=$2 AND status='issued' AND expires_at>now()",
          [c.user_id, p.t],
        ),
      );
    },
  );
  route(
    app,
    "POST",
    "/api/v1/work/:t/customers/:c/link-invites",
    {
      roles: manage,
      schema: empty,
      description: "Одноразовая ссылка двухсторонней привязки ручной карточки",
    },
    async ({ db, actor, p }) => {
      const c = required(
        await one<Customer>(
          db,
          "SELECT * FROM customers WHERE id=$1 AND tenant_id=$2",
          [p.c, p.t],
        ),
      );
      if (c.user_id)
        fail(409, "CUSTOMER_LINK_CONFLICT", "Карточка уже связана с аккаунтом");
      const token = randomToken();
      const inv = (await one<Invite>(
        db,
        "INSERT INTO invites(tenant_id,kind,customer_id,token_hash) VALUES($1,'customer',$2,$3) RETURNING id,expires_at,version",
        [p.t, p.c, hash(token)],
      ))!;
      await audit(db, p.t!, actor.id, "crm.link_invited", c.id);
      return {
        ...inv,
        token,
        url: `https://max.ru/${config.MAX_BOT_NAME}?startapp=c_${token}`,
        browserUrl: `${config.PUBLIC_APP_URL}/invite/${token}`,
      };
    },
  );
  route(
    app,
    "POST",
    "/api/v1/work/:t/customer-link-invites/:id/confirm",
    {
      roles: manage,
      schema: expected,
      description: "Второе подтверждение привязки сотрудником",
    },
    async ({ db, actor, p, b }) => {
      const inv = required(
        await one<Invite>(
          db,
          "SELECT * FROM invites WHERE id=$1 AND tenant_id=$2 AND kind='customer'",
          [p.id, p.t],
        ),
      );
      version(inv, b.expectedVersion);
      if (inv.status !== "client_confirmed" || inv.expires_at < new Date())
        fail(
          409,
          "INVALID_STATE_TRANSITION",
          "Клиент ещё не подтвердил привязку или ссылка истекла",
        );
      const c = required(
        await one<Customer>(
          db,
          "SELECT * FROM customers WHERE id=$1 AND tenant_id=$2",
          [inv.customer_id, p.t],
        ),
      );
      if (
        c.user_id ||
        (await one(
          db,
          "SELECT id FROM customers WHERE tenant_id=$1 AND user_id=$2",
          [p.t, inv.candidate_user_id],
        ))
      )
        fail(
          409,
          "CUSTOMER_LINK_CONFLICT",
          "У аккаунта уже есть карточка или карточка уже связана. Автоматическое слияние отключено.",
        );
      await db.query(
        "UPDATE customers SET user_id=$2,version=version+1 WHERE id=$1",
        [c.id, inv.candidate_user_id],
      );
      await db.query("UPDATE bookings SET user_id=$2 WHERE customer_id=$1", [
        c.id,
        inv.candidate_user_id,
      ]);
      await db.query(
        "UPDATE invites SET status='accepted',version=version+1 WHERE id=$1",
        [inv.id],
      );
      await audit(db, p.t!, actor.id, "crm.customer_linked", c.id);
      return { ok: true };
    },
  );
  accessRoutes(app);
}
function accessRoutes(app: FastifyInstance) {
  route(
    app,
    "GET",
    "/api/v1/work/:t/memberships",
    { roles: ["owner"], description: "Рабочие роли и приглашения" },
    async ({ db, p }) => ({
      items: await rows(
        db,
        "SELECT m.*,u.display_name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY m.role,u.display_name",
        [p.t],
      ),
      invites: await rows(
        db,
        "SELECT id,role,status,expires_at,version FROM invites WHERE tenant_id=$1 AND kind='staff' ORDER BY created_at DESC",
        [p.t],
      ),
    }),
  );
  route(
    app,
    "POST",
    "/api/v1/work/:t/staff-invites",
    {
      roles: ["owner"],
      schema: z
        .object({
          role: z.enum(["admin", "master"]),
          staffId: id.optional(),
          expectedUserId: id.optional(),
        })
        .strict(),
      description: "Приглашение сотрудника на 24 часа",
    },
    async ({ db, actor, p, b }) => {
      if (b.role === "master" && !b.staffId)
        fail(
          422,
          "VALIDATION_ERROR",
          "Для мастера выберите карточку исполнителя",
        );
      if (b.staffId) {
        const s = required(
          await one<Staff>(
            db,
            "SELECT * FROM staff WHERE id=$1 AND tenant_id=$2",
            [b.staffId, p.t],
          ),
        );
        if (
          s.membership_id &&
          (await one(
            db,
            "SELECT 1 FROM memberships WHERE id=$1 AND status='active'",
            [s.membership_id],
          ))
        )
          fail(409, "CONFLICT", "К этому мастеру уже привязан сотрудник");
      }
      const token = randomToken();
      const inv = (await one<Invite>(
        db,
        "INSERT INTO invites(tenant_id,kind,role,staff_id,expected_user_id,token_hash) VALUES($1,'staff',$2,$3,$4,$5) RETURNING id,expires_at,version",
        [p.t, b.role, b.staffId ?? null, b.expectedUserId ?? null, hash(token)],
      ))!;
      await audit(db, p.t!, actor.id, "membership.invited", inv.id);
      return {
        ...inv,
        token,
        url: `https://max.ru/${config.MAX_BOT_NAME}?startapp=i_${token}`,
        browserUrl: `${config.PUBLIC_APP_URL}/invite/${token}`,
      };
    },
  );
  for (const name of ["staff-invites", "customer-link-invites"])
    route(
      app,
      "POST",
      `/api/v1/work/:t/${name}/:id/revoke`,
      {
        roles: name === "staff-invites" ? ["owner"] : manage,
        schema: expected,
        description: "Отозвать неиспользованное приглашение",
      },
      async ({ db, actor, p, b }) => {
        const inv = required(
          await one<Invite>(
            db,
            "SELECT * FROM invites WHERE id=$1 AND tenant_id=$2 AND kind=$3",
            [p.id, p.t, name === "staff-invites" ? "staff" : "customer"],
          ),
        );
        version(inv, b.expectedVersion);
        if (!["pending", "client_confirmed"].includes(inv.status))
          fail(409, "INVALID_STATE_TRANSITION", "Приглашение уже обработано");
        await audit(db, p.t!, actor.id, "membership.invite_revoked", inv.id);
        return one(
          db,
          "UPDATE invites SET status='revoked',version=version+1 WHERE id=$1 RETURNING id,status,version",
          [inv.id],
        );
      },
    );
  route(
    app,
    "POST",
    "/api/v1/invites/inspect",
    {
      schema: z.object({ token: z.string().min(20).max(100) }).strict(),
      noIdempotency: true,
      description: "Минимальные сведения о приглашении без раскрытия истории",
    },
    async ({ db, b }) => {
      const inv = required(
        await one<Invite & { tenant_name: string }>(
          db,
          "SELECT i.*,t.name tenant_name FROM invites i JOIN tenants t ON t.id=i.tenant_id WHERE token_hash=$1 AND status IN ('pending','client_confirmed') AND expires_at>now()",
          [hash(b.token)],
        ),
      );
      return {
        id: inv.id,
        kind: inv.kind,
        role: inv.role,
        tenantName: inv.tenant_name,
        expiresAt: inv.expires_at,
        version: inv.version,
        status: inv.status,
      };
    },
  );
  route(
    app,
    "POST",
    "/api/v1/invites/accept",
    {
      schema: z
        .object({
          token: z.string().min(20).max(100),
          explicitConfirmation: z.literal(true),
        })
        .strict(),
      description: "Явное принятие приглашения сотрудником или клиентом",
    },
    async ({ db, actor, b }) => {
      const inv = required(
        await one<Invite>(db, "SELECT * FROM invites WHERE token_hash=$1", [
          hash(b.token),
        ]),
      );
      if (inv.status !== "pending" || inv.expires_at < new Date())
        fail(
          409,
          "INVALID_STATE_TRANSITION",
          "Приглашение уже использовано или истекло",
        );
      if (inv.expected_user_id && inv.expected_user_id !== actor.id)
        fail(404, "NOT_FOUND", "Приглашение предназначено другому аккаунту");
      if (inv.kind === "staff") {
        const old = await one<Membership>(
          db,
          "SELECT * FROM memberships WHERE tenant_id=$1 AND user_id=$2",
          [inv.tenant_id, actor.id],
        );
        if (old?.status === "active")
          fail(
            409,
            "CONFLICT",
            "Аккаунт уже имеет активную роль в этом салоне",
          );
        const member = (await one<Membership>(
          db,
          "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(tenant_id,user_id) DO UPDATE SET role=$3,status='active',notifications_enabled=false,version=memberships.version+1 RETURNING *",
          [inv.tenant_id, actor.id, inv.role],
        ))!;
        if (inv.staff_id) {
          const s = required(
            await one<Staff>(db, "SELECT * FROM staff WHERE id=$1", [
              inv.staff_id,
            ]),
          );
          if (
            s.membership_id &&
            s.membership_id !== member.id &&
            (await one(
              db,
              "SELECT 1 FROM memberships WHERE id=$1 AND status='active'",
              [s.membership_id],
            ))
          )
            fail(409, "CONFLICT", "Мастер уже связан с другим сотрудником");
          await db.query(
            "UPDATE staff SET membership_id=$2,version=version+1 WHERE id=$1",
            [s.id, member.id],
          );
        }
      }
      const state = inv.kind === "staff" ? "accepted" : "client_confirmed";
      await db.query(
        "UPDATE invites SET status=$2,candidate_user_id=$3,version=version+1 WHERE id=$1",
        [inv.id, state, actor.id],
      );
      await audit(
        db,
        inv.tenant_id,
        actor.id,
        inv.kind === "staff"
          ? "membership.accepted"
          : "crm.link_client_confirmed",
        inv.id,
      );
      return { status: state, tenantId: inv.tenant_id };
    },
  );
  route(
    app,
    "POST",
    "/api/v1/work/:t/memberships/:id/revoke",
    {
      roles: ["owner"],
      schema: expected.extend({ reason }).strict(),
      description: "Немедленный отзыв рабочего доступа",
    },
    async ({ db, actor, p, b }) => {
      const m = required(
        await one<Membership>(
          db,
          "SELECT * FROM memberships WHERE id=$1 AND tenant_id=$2",
          [p.id, p.t],
        ),
      );
      version(m, b.expectedVersion);
      if (m.role === "owner")
        fail(
          409,
          "INVALID_STATE_TRANSITION",
          "Отзыв роли владельца в этой версии не поддерживается",
        );
      await db.query(
        "UPDATE memberships SET status='revoked',notifications_enabled=false,version=version+1 WHERE id=$1",
        [m.id],
      );
      await db.query(
        "UPDATE deliveries SET state='suppressed',last_error='ACCESS_REVOKED' WHERE membership_id=$1 AND state IN ('scheduled','retry_wait')",
        [m.id],
      );
      await db.query(
        "UPDATE tenants SET operational_recipient_id=(SELECT user_id FROM memberships WHERE tenant_id=$1 AND role='owner' AND status='active' ORDER BY id LIMIT 1) WHERE id=$1 AND operational_recipient_id=$2",
        [p.t, m.user_id],
      );
      await audit(db, p.t!, actor.id, "membership.revoked", m.id, {
        reason: b.reason,
      });
      return { ok: true };
    },
  );
  route(
    app,
    "PUT",
    "/api/v1/work/:t/operational-recipient",
    {
      roles: ["owner"],
      schema: expected.extend({ membershipId: id }).strict(),
      description: "Назначить единственного операционного получателя",
    },
    async ({ db, actor, p, b }) => {
      const t = required(
        await one<{ version: number }>(
          db,
          "SELECT version FROM tenants WHERE id=$1",
          [p.t],
        ),
      );
      version(t, b.expectedVersion);
      const m = required(
        await one<Membership>(
          db,
          "SELECT * FROM memberships WHERE tenant_id=$1 AND id=$2 AND status='active' AND role IN ('owner','admin')",
          [p.t, b.membershipId],
        ),
      );
      await audit(db, p.t!, actor.id, "membership.operational_recipient", m.id);
      return one(
        db,
        "UPDATE tenants SET operational_recipient_id=$2,version=version+1 WHERE id=$1 RETURNING id,version",
        [p.t, m.user_id],
      );
    },
  );
  route(
    app,
    "PATCH",
    "/api/v1/work/:t/my-notification-preferences",
    {
      roles: ["owner", "admin", "master"],
      schema: expected.extend({ enabled: z.boolean() }).strict(),
      description: "Согласие на рабочие сообщения бота",
    },
    async ({ db, actor, member, p, b }) => {
      version(member, b.expectedVersion);
      await audit(db, p.t!, actor.id, "consent.work_notifications", member.id, {
        enabled: b.enabled,
      });
      return one(
        db,
        "UPDATE memberships SET notifications_enabled=$2,version=version+1 WHERE id=$1 RETURNING *",
        [member.id, b.enabled],
      );
    },
  );
}
