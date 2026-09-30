import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, useApi, useAuth, refreshData } from "./api";
import {
  PageTitle,
  Load,
  Field,
  Check,
  Badge,
  useAction,
  SimpleForm,
  CommandButton,
  Modal,
  FilePick,
  TimezonePicker,
} from "./ui";
import { Asset } from "./personal";
import { StorefrontEditor } from "./storefront-editor";
import { LinkBox } from "./work";
import type {
  Salon,
  Media,
  Items,
  Service,
  Staff,
  Category,
  Membership,
} from "./types";

export function SettingsPage() {
  const { t } = useParams();
  const auth = useAuth();
  const profile = useApi<Salon>(`/work/${t}/profile`),
    draft = useApi<Salon>(`/work/${t}/storefront/draft`),
    check = useApi<{ items: { key: string; label: string; done: boolean }[] }>(
      `/work/${t}/onboarding`,
    ),
    entry = useApi<{ url: string; browserUrl: string; qrDataUrl: string }>(
      `/work/${t}/entry-link`,
    );
  const services = useApi<Items<Service>>(`/work/${t}/services`),
    staff = useApi<Items<Staff>>(`/work/${t}/staff`),
    categories = useApi<Items<Category>>(`/work/${t}/categories`);
  const a = useAction();
  const avatarAction = useAction();
  const member = auth.me!.memberships.find((m) => m.tenantId === t)!;
  const replaceAvatar = async (file?: File) => {
    if (!file) return;
    const form = new FormData();
    form.append("purpose", "logo");
    form.append("file", file);
    await avatarAction.run(async () => {
      const media = await api<Media>(`/work/${t}/media`, "POST", form);
      const current = await api<Salon>(`/work/${t}/profile`);
      await api<Salon>(`/work/${t}/storefront/avatar`, "POST", {
        expectedVersion: current.version,
        mediaId: media.id,
      });
      refreshData();
    }, profile.data?.status === "published"
      ? "Аватар салона обновлён и виден клиентам"
      : "Аватар салона обновлён. Он появится на витрине после публикации салона.");
  };
  return (
    <>
      <PageTitle
        title="Настройки салона"
        description="Профиль, оформление и публикация. Оформление витрины публикуется из черновика, аватар обновляется сразу."
      />
      <div className="profile-links"><Link to={`/work/${t}/live-window`}>Настройки и цепочки «Живого окна» →</Link></div>
      <Load {...profile}>
        {profile.data &&
          (() => {
            const salon = profile.data;
            return (
              <>
                <section className="panel">
                  <div className="section-head">
                    <h2>{salon.name}</h2>
                    <Badge status={salon.status ?? "draft"} />
                  </div>
                  <div className="checklist">
                    {check.data?.items.map((c) => (
                      <div key={c.key} className={c.done ? "done" : ""}>
                        <span>{c.done ? "✓" : "○"}</span>
                        {c.label}
                        {!c.done && (
                          <Link
                            to={`/work/${t}/${c.key === "schedule" ? "schedule" : c.key === "profile" ? "settings" : "catalog"}`}
                          >
                            Настроить →
                          </Link>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="inline-actions">
                    {["draft", "paused"].includes(salon.status!) && (
                      <CommandButton
                        path={`/work/${t}/publish`}
                        body={{ expectedVersion: salon.version }}
                        label="Опубликовать салон"
                      />
                    )}
                    {salon.status === "published" && (
                      <CommandButton
                        path={`/work/${t}/pause`}
                        body={{ expectedVersion: salon.version }}
                        label="Поставить на паузу"
                      />
                    )}
                    {["draft", "paused"].includes(salon.status!) && (
                      <CommandButton
                        path={`/work/${t}/archive`}
                        body={{ expectedVersion: salon.version }}
                        label="Архивировать"
                      />
                    )}
                    {salon.status === "archived" && (
                      <CommandButton
                        path={`/work/${t}/restore`}
                        body={{ expectedVersion: salon.version }}
                        label="Восстановить в паузу"
                      />
                    )}
                    <Link
                      to={`/s/${salon.publicCode}`}
                      className="button secondary"
                    >
                      Открыть витрину
                    </Link>
                  </div>
                </section>
                <section className="panel salon-avatar-panel">
                  <div className="salon-avatar-preview">
                    <Asset
                      tenantId={salon.id}
                      media={draft.data?.media?.find((media) => media.id === salon.publishedStyle?.logoMediaId)}
                      alt="Аватар салона"
                    />
                    {!salon.publishedStyle?.logoMediaId && salon.name.charAt(0)}
                  </div>
                  <div className="salon-avatar-details">
                    <h2>Аватар салона</h2>
                    <p>Логотип на витрине и в карточке салона. Выбранное фото сохраняется сразу. JPEG, PNG или WebP до 5 МБ.</p>
                    <FilePick
                      accept="image/jpeg,image/png,image/webp"
                      disabled={avatarAction.busy || a.busy}
                      onPick={(file) => void replaceAvatar(file)}
                      label={salon.publishedStyle?.logoMediaId ? "Заменить аватар" : "Добавить аватар"}
                    />
                    {avatarAction.feedback}
                  </div>
                </section>
                <div className="two-columns">
                  <section className="panel">
                    <h2>Профиль</h2>
                    <SimpleForm
                      key={salon.id}
                      submitDisabled={avatarAction.busy || a.busy}
                      fields={[
                        { name: "name", label: "Название" },
                        { name: "category", label: "Направление" },
                        { name: "address", label: "Адрес" },
                        { name: "contact", label: "Публичный контакт" },
                      ]}
                      initial={{
                        name: salon.name,
                        category: salon.category,
                        address: salon.address,
                        contact: salon.contact,
                        timezone: salon.timezone,
                      }}
                      onSubmit={async (v) => {
                        await api(`/work/${t}/profile`, "PATCH", {
                          ...v,
                          expectedVersion: salon.version,
                        });
                        await auth.reload();
                      }}
                    >
                      <TimezonePicker defaultValue={salon.timezone} />
                    </SimpleForm>
                  </section>
                  <section className="panel">
                    <h2>Ссылка и QR</h2>
                    {entry.data && (
                      <>
                        <img
                          className="qr-image"
                          alt="QR входа в салон через MAX"
                          src={entry.data.qrDataUrl}
                        />
                        <input
                          className="link-field"
                          aria-label="Публичная ссылка салона"
                          readOnly
                          value={entry.data.url}
                          onFocus={(e) => e.target.select()}
                        />
                        <div className="inline-actions">
                          <button
                            className="button secondary"
                            onClick={() =>
                              void a.run(
                                () =>
                                  navigator.clipboard.writeText(
                                    entry.data!.url,
                                  ),
                                "Ссылка скопирована",
                              )
                            }
                          >
                            Копировать
                          </button>
                          <a
                            className="button secondary"
                            href={entry.data.qrDataUrl}
                            download={`${salon.publicCode}-qr.png`}
                          >
                            Скачать QR
                          </a>
                        </div>
                        <p className="small muted">
                          QR ведёт в общий MAX mini-app с контекстом этого
                          салона. В демо используйте{" "}
                          <a href={entry.data.browserUrl}>браузерную ссылку</a>.
                        </p>
                      </>
                    )}
                    <hr />
                    <h3>Рабочие сообщения</h3>
                    <Check
                      label="Получать события своих назначений / операционные сообщения"
                      checked={member.notificationsEnabled}
                      disabled={a.busy}
                      onChange={(enabled) =>
                        void a.run(async () => {
                          await api(
                            `/work/${t}/my-notification-preferences`,
                            "PATCH",
                            { enabled, expectedVersion: member.version },
                          );
                          await auth.reload();
                        })
                      }
                    />
                  </section>
                </div>
                {draft.data && (
                  <StorefrontEditor
                    tenantId={t!}
                    salon={salon}
                    draft={draft.data}
                    services={services.data?.items ?? []}
                    staff={staff.data?.items ?? []}
                    categories={categories.data?.items ?? []}
                    enabled={auth.storefrontThemesV2}
                  />
                )}
              </>
            );
          })()}
      </Load>
    </>
  );
}

export function AccessPage() {
  const { t } = useParams();
  const data = useApi<
    Items<Membership> & {
      invites: {
        id: string;
        role: string;
        status: string;
        version: number;
        expiresAt: string;
      }[];
    }
  >(`/work/${t}/memberships`, true);
  const staff = useApi<Items<Staff>>(`/work/${t}/staff`),
    profile = useApi<Salon>(`/work/${t}/profile`);
  const [role, setRole] = useState("admin"),
    [selectedStaff, setSelectedStaff] = useState(""),
    [link, setLink] = useState<{ url: string; browserUrl: string }>(),
    [revoke, setRevoke] = useState<Membership>();
  const a = useAction();
  return (
    <>
      <PageTitle
        title="Сотрудники и доступ"
        description="Приглашения одноразовые, действуют 24 часа. Отозванная роль перестаёт работать на следующем запросе."
      />
      <div className="two-columns">
        <section className="panel">
          <h2>Пригласить сотрудника</h2>
          <Field label="Роль">
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="admin">Администратор</option>
              <option value="master">Мастер</option>
            </select>
          </Field>
          {role === "master" && (
            <Field label="Карточка мастера">
              <select
                value={selectedStaff}
                onChange={(e) => setSelectedStaff(e.target.value)}
              >
                <option value="">Выберите исполнителя</option>
                {staff.data?.items.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <button
            className="button primary"
            disabled={a.busy || (role === "master" && !selectedStaff)}
            onClick={() =>
              void a.run(
                async () =>
                  setLink(
                    await api(`/work/${t}/staff-invites`, "POST", {
                      role,
                      ...(role === "master" ? { staffId: selectedStaff } : {}),
                    }),
                  ),
                "Приглашение создано",
              )
            }
          >
            Создать приглашение
          </button>
          {a.feedback}
          {link && <LinkBox {...link} />}
          <p className="small muted">
            Ссылку может принять тот, кому вы её передадите. Проверяйте имя
            принявшего в списке доступа. Самостоятельная смена роли через
            интерфейс клиента невозможна.
          </p>
        </section>
        <section className="panel">
          <h2>Кто получает рабочие события</h2>
          <p>
            Одно операционное сообщение направляется выбранному владельцу или
            администратору. Мастер получает только события своих назначений.
            Получатели отдельно включают рабочие сообщения.
          </p>
          {data.data && profile.data && (
            <Field label="Операционный получатель">
              <select
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value)
                    void a.run(() =>
                      api(`/work/${t}/operational-recipient`, "PUT", {
                        membershipId: e.target.value,
                        expectedVersion: profile.data!.version,
                      }),
                    );
                }}
              >
                <option value="">Выберите получателя</option>
                {data.data.items
                  .filter((m) => m.status === "active" && m.role !== "master")
                  .map((m) => (
                    <option value={m.id} key={m.id}>
                      {m.displayName}
                    </option>
                  ))}
              </select>
            </Field>
          )}
        </section>
      </div>
      <Load {...data}>
        <section className="panel">
          <h2>Доступ к салону</h2>
          {data.data?.items.map((m) => (
            <div className="history-row" key={m.id}>
              <div>
                <strong>{m.displayName}</strong>
                <p>
                  <Badge status={m.role} /> <Badge status={m.status} />
                </p>
              </div>
              {m.role !== "owner" && m.status === "active" && (
                <button
                  className="button secondary danger-text"
                  onClick={() => setRevoke(m)}
                >
                  Отозвать доступ
                </button>
              )}
            </div>
          ))}
          <h3>Приглашения</h3>
          {data.data?.invites.map((i) => (
            <div className="history-row" key={i.id}>
              <Badge status={i.role} />
              <Badge status={i.status} />
              {i.status === "pending" && (
                <CommandButton
                  path={`/work/${t}/staff-invites/${i.id}/revoke`}
                  body={{ expectedVersion: i.version }}
                  label="Отозвать"
                />
              )}
            </div>
          ))}
        </section>
      </Load>
      {revoke && (
        <Modal
          title={`Отозвать доступ · ${revoke.displayName}`}
          onClose={() => setRevoke(undefined)}
        >
          <SimpleForm
            fields={[{ name: "reason", label: "Причина", type: "textarea" }]}
            submit="Отозвать"
            onSubmit={async (v) => {
              await api(`/work/${t}/memberships/${revoke.id}/revoke`, "POST", {
                expectedVersion: revoke.version,
                reason: v.reason,
              });
              setRevoke(undefined);
            }}
          />
        </Modal>
      )}
    </>
  );
}
