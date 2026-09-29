import { CustomerLoyalty } from "./loyalty";
import { useEffect, useState } from "react";
import { DateTime } from "luxon";
import { Link, useParams } from "react-router-dom";
import { api, useApi, useAuth } from "./api";
import {
  PageTitle,
  Load,
  Empty,
  Field,
  Check,
  Badge,
  money,
  dateTime,
  dayISO,
  useAction,
  Modal,
  SimpleForm,
  BackLink,
  CommandButton,
  Icon,
  plural,
  FilePick,
} from "./ui";
import { Asset, BookingCard } from "./personal";
import type {
  Booking,
  Items,
  Customer,
  Staff,
  Service,
  Category,
  Schedule,
  Weekday,
  Interval,
  Media,
} from "./types";
export { SettingsPage, AccessPage } from "./work-settings";

function MasterPhotoCard({ tenantId }: { tenantId: string }) {
  const profile = useApi<Staff>(`/work/${tenantId}/my-staff-profile`);
  const action = useAction();
  const upload = async (file?: File) => {
    if (!file || !profile.data) return;
    const form = new FormData();
    form.append("purpose", "staff");
    form.append("file", file);
    await action.run(async () => {
      const media = await api<Media>(
        `/work/${tenantId}/media`,
        "POST",
        form,
      );
      await api(`/work/${tenantId}/my-staff-profile`, "PATCH", {
        expectedVersion: profile.data!.version,
        photoMediaId: media.id,
      });
    }, "Фотография профиля обновлена");
  };
  return (
    <Load {...profile}>
      {profile.data && (
        <section className="panel master-profile-card">
          <div className="staff-avatar">
            {profile.data.photoMediaId ? (
              <Asset
                tenantId={tenantId}
                media={{
                  id: profile.data.photoMediaId,
                  fileKey: "",
                  purpose: "staff",
                }}
                privateAsset
                alt={`Фото ${profile.data.name}`}
              />
            ) : (
              profile.data.name.charAt(0)
            )}
          </div>
          <div>
            <h3>{profile.data.name}</h3>
            <p>Эта фотография отображается клиентам в витрине салона.</p>
            <div className="staff-rating">
              {profile.data.ratingCount
                ? `★ ${profile.data.ratingAverage?.toLocaleString("ru-RU")} · ${plural(profile.data.ratingCount, "оценка", "оценки", "оценок")}`
                : "Пока нет оценок"}
            </div>
          </div>
          <FilePick
            accept="image/jpeg,image/png,image/webp"
            disabled={action.busy}
            label="Заменить фото"
            onPick={(file) => void upload(file)}
          />
          {action.feedback}
        </section>
      )}
    </Load>
  );
}

export function WorkCalendar() {
  const { t } = useParams(),
    auth = useAuth();
  const role = auth.me!.memberships.find((m) => m.tenantId === t)?.role;
  const [selected, setSelected] = useState(dayISO());
  const [month, setMonth] = useState(dayISO().slice(0, 7));
  const [staff, setStaff] = useState("");
  const [staffQuery, setStaffQuery] = useState("");
  const [staffOpen, setStaffOpen] = useState(false);
  const [zone, setZone] = useState("Europe/Moscow");
  const start = DateTime.fromISO(`${month}-01`, { zone }).startOf("month");
  const end = start.plus({ months: 1 });
  const data = useApi<Items<Booking> & { timezone: string }>(
    `/work/${t}/calendar?from=${encodeURIComponent(start.toISO()!)}&to=${encodeURIComponent(end.toISO()!)}&staffId=${staff}`,
    true,
  );
  useEffect(() => { if (data.data?.timezone && data.data.timezone !== zone) setZone(data.data.timezone); }, [data.data?.timezone, zone]);
  const workers = useApi<Items<Staff>>(
    role !== "master" ? `/work/${t}/staff` : null,
  );
  const windows = useApi<Items<{id:string;status:string;startAt:string;staffId:string;serviceName:string;staffName:string;sourceBookingId:string}>>(role !== "master" ? `/work/${t}/live-window/windows` : null);
  const bookings = data.data?.items.filter((booking) => booking.status !== "cancelled" && DateTime.fromISO(booking.startAt).setZone(zone).toFormat("yyyy-MM") === month) ?? [];
  const byDay = new Map<string, Booking[]>();
  for (const booking of bookings) {
    const key = DateTime.fromISO(booking.startAt).setZone(zone).toISODate()!;
    byDay.set(key, [...(byDay.get(key) ?? []), booking]);
  }
  const dayBookings = byDay.get(selected) ?? [];
  const dayWindows = windows.data?.items.filter((window) => DateTime.fromISO(window.startAt).setZone(zone).toISODate() === selected && (!staff || window.staffId === staff) && ["detected","matching","offering"].includes(window.status)) ?? [];
  const days = start.daysInMonth ?? 30;
  const offset = (start.weekday + 6) % 7;
  const chosenStaff = workers.data?.items.find((worker) => worker.id === staff);
  const matches = workers.data?.items.filter((worker) => worker.name.toLocaleLowerCase("ru-RU").includes(staffQuery.trim().toLocaleLowerCase("ru-RU"))) ?? [];
  const changeMonth = (delta: number) => {
    const next = start.plus({ months: delta });
    setMonth(next.toFormat("yyyy-MM"));
    setSelected(next.toISODate()!);
  };
  return (
    <>
      <PageTitle
        eyebrow={role === "master" ? "ТОЛЬКО ВАШИ НАЗНАЧЕНИЯ" : "РАБОЧЕЕ ПРОСТРАНСТВО"}
        title={role === "master" ? "Мой календарь" : "Записи салона"}
        description="Выберите месяц и день, чтобы открыть записи по времени."
        action={
          role !== "master" && (
            <Link className="button primary" to={`/work/${t}/bookings/new`}>
              <Icon name="plus" />
              Записать клиента
            </Link>
          )
        }
      />
      {role === "master" && <MasterPhotoCard tenantId={t!} />}
      {role !== "master" && <div className="staff-filter">
        <span className="eyebrow">МАСТЕР</span>
        <button type="button" className="staff-filter-trigger" aria-expanded={staffOpen} onClick={() => setStaffOpen(!staffOpen)}>{chosenStaff?.name ?? "Все мастера"}<span aria-hidden="true">⌄</span></button>
        {staffOpen && <div className="staff-filter-menu"><input autoFocus type="search" aria-label="Поиск мастера" placeholder="Найти мастера" value={staffQuery} onChange={(event) => setStaffQuery(event.target.value)} />
          <button type="button" onClick={() => {setStaff("");setStaffOpen(false);}}>Все мастера</button>
          {matches.map((worker) => <button type="button" key={worker.id} onClick={() => {setStaff(worker.id);setStaffOpen(false);}}>{worker.name}</button>)}
          {!matches.length && <p className="muted">Мастер не найден</p>}
        </div>}
      </div>}
      <Load {...data}><div className="month-layout">
        <section className="month-calendar panel" aria-label="Календарь записей">
          <div className="month-heading"><button type="button" aria-label="Предыдущий месяц" onClick={() => changeMonth(-1)}>‹</button><div><h2>{start.setLocale("ru").toFormat("LLLL yyyy")}</h2><span>{plural(bookings.length, "запись", "записи", "записей")} за месяц</span></div><button type="button" aria-label="Следующий месяц" onClick={() => changeMonth(1)}>›</button></div>
          <div className="month-weekdays">{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((name) => <span key={name}>{name}</span>)}</div>
          <div className="month-days">{Array.from({ length: offset }, (_, index) => <span key={`empty-${index}`} />)}
            {Array.from({ length: days }, (_, index) => { const day = start.plus({ days: index }); const key = day.toISODate()!; const count = byDay.get(key)?.length ?? 0; return <button type="button" key={key} className={selected === key ? "selected" : ""} aria-pressed={selected === key} aria-label={`${day.setLocale("ru").toFormat("d LLLL")}: ${plural(count, "запись", "записи", "записей")}`} onClick={() => setSelected(key)}><span>{index + 1}</span>{count > 0 && <small>{count}</small>}</button>; })}
          </div>
        </section>
        <section className="month-agenda"><div className="section-head"><h2>{DateTime.fromISO(selected).setLocale("ru").toFormat("d LLLL")}</h2><span className="muted">{plural(dayBookings.length, "запись", "записи", "записей")}</span></div>
          {dayBookings.length ? <div className="agenda-list">{dayBookings.map((booking) => <BookingCard key={booking.id} booking={booking} work />)}</div>
            : <Empty title="На этот день записей нет" text="Выберите другой день или месяц." />}
          {role !== "master" && dayWindows.length > 0 && <div className="open-windows"><h3>Освободившееся время</h3><p>Это не подтверждённые записи.</p>{dayWindows.map((window) => <Link key={window.id} className="booking-card" to={`/work/${t}/live-window?sourceBookingId=${window.sourceBookingId}`}><div><strong>{DateTime.fromISO(window.startAt).setZone(zone).toFormat("HH:mm")} · {window.serviceName}</strong><p>{window.staffName} · цепочка предложений</p></div><Icon name="arrow" /></Link>)}</div>}
        </section>
      </div></Load>
    </>
  );
}
const customerFields = [
  { name: "displayName", label: "Имя клиента" },
  {
    name: "contact",
    label: "Дополнительный контакт",
    required: false,
    hint: "Необязательно. Указывайте только с разрешения клиента.",
  },
  { name: "tags", label: "Теги через запятую", required: false },
];
export function CustomersPage() {
  const { t } = useParams();
  const [query, setQuery] = useState(""),
    [tag, setTag] = useState(""),
    [modal, setModal] = useState(false);
  const data = useApi<Items<Customer>>(
    `/work/${t}/customers?limit=100&query=${encodeURIComponent(query)}&tag=${encodeURIComponent(tag)}`,
  );
  return (
    <>
      <PageTitle
        title="Клиенты"
        description="Карточки, заметки и история только вашего салона."
        action={
          <button className="button primary" onClick={() => setModal(true)}>
            <Icon name="plus" />
            Новый клиент
          </button>
        }
      />
      <div className="filters">
        <input
          aria-label="Поиск клиентов"
          placeholder="Имя или контакт"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <input
          aria-label="Фильтр по тегу"
          placeholder="Тег"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
        />
      </div>
      <Load {...data}>
        {data.data?.items.length ? (
          <div className="data-list">
            {data.data.items.map((c) => (
              <Link
                className="customer-row"
                key={c.id}
                to={`/work/${t}/customers/${c.id}`}
              >
                <span className="avatar">{c.displayName.charAt(0)}</span>
                <div>
                  <h3>{c.displayName}</h3>
                  <p>
                    {c.contact || "Контакт не указан"} ·{" "}
                    {c.userId ? "Аккаунт MAX привязан" : "Ручная карточка"}
                  </p>
                  <div className="tags">
                    {c.tags.map((t) => (
                      <span key={t}>{t}</span>
                    ))}
                  </div>
                </div>
                <div className="customer-count">
                  <strong>{c.completedVisits}</strong>
                  <small>визитов</small>
                </div>
                <Icon name="arrow" />
              </Link>
            ))}
          </div>
        ) : (
          <Empty
            title="Клиенты не найдены"
            text="Создайте ручную карточку или дождитесь первой самостоятельной записи."
          />
        )}
      </Load>
      {modal && (
        <Modal title="Ручной клиент" onClose={() => setModal(false)}>
          <SimpleForm
            fields={customerFields}
            submit="Создать карточку"
            onSubmit={async (v) => {
              await api(`/work/${t}/customers`, "POST", {
                ...v,
                tags: (v.tags ?? "")
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              });
              setModal(false);
            }}
          />
        </Modal>
      )}
    </>
  );
}
export function CustomerPage() {
  const { t, id } = useParams();
  const data = useApi<Customer>(`/work/${t}/customers/${id}`, true);
  const [link, setLink] = useState<{ url: string; browserUrl: string }>(),
    [edit, setEdit] = useState(false);
  const a = useAction();
  return (
    <>
      <BackLink to={`/work/${t}/customers`} label="Все клиенты" />
      <PageTitle
        title={data.data?.displayName ?? "Карточка клиента"}
        action={
          <Link
            className="button primary"
            to={`/work/${t}/bookings/new?customer=${id}`}
          >
            Записать клиента
          </Link>
        }
      />
      <Load {...data}>
        {data.data &&
          (() => {
            const c = data.data;
            return (
              <>
                <div className="two-columns">
                  <section className="panel">
                    <div className="section-head">
                      <h2>Контакт и теги</h2>
                      <button
                        className="text-button"
                        onClick={() => setEdit(true)}
                      >
                        Изменить
                      </button>
                    </div>
                    <p>{c.contact || "Контакт не указан"}</p>
                    <div className="tags">
                      {c.tags.map((t) => (
                        <span key={t}>{t}</span>
                      ))}
                    </div>
                    <hr />
                    <h3>Связь с MAX</h3>
                    <p>
                      {c.userId
                        ? "Аккаунт подтверждён. Новые события доступны по настройкам клиента."
                        : "Ручная карточка: сообщения MAX не отправляются. Привяжите аккаунт только после двух подтверждений."}
                    </p>
                    {!c.userId && (
                      <button
                        className="button secondary"
                        disabled={a.busy}
                        onClick={() =>
                          void a.run(
                            async () =>
                              setLink(
                                await api(
                                  `/work/${t}/customers/${id}/link-invites`,
                                  "POST",
                                  {},
                                ),
                              ),
                            "Ссылка создана",
                          )
                        }
                      >
                        Создать ссылку привязки
                      </button>
                    )}
                    {a.feedback}
                    {link && <LinkBox {...link} />}{" "}
                    {c.linkInvites?.map((i) => (
                      <div className="sub-panel" key={i.id}>
                        <Badge status={i.status} />
                        {i.candidateName && (
                          <p>
                            Кандидат: <strong>{i.candidateName}</strong>
                          </p>
                        )}
                        {i.status === "client_confirmed" && (
                          <CommandButton
                            path={`/work/${t}/customer-link-invites/${i.id}/confirm`}
                            body={{ expectedVersion: i.version }}
                            label="Подтверждаю: это тот клиент"
                          />
                        )}
                        {["pending", "client_confirmed"].includes(i.status) && (
                          <CommandButton
                            path={`/work/${t}/customer-link-invites/${i.id}/revoke`}
                            body={{ expectedVersion: i.version }}
                            label="Отозвать ссылку"
                          />
                        )}
                      </div>
                    ))}
                  </section>
                  <section className="panel">
                    <h2>Внутренние заметки</h2>
                    <p className="muted small">
                      Доступны владельцу и администратору. Не видны клиенту и
                      мастеру.
                    </p>
                    <SimpleForm
                      fields={[
                        {
                          name: "body",
                          label: "Новая заметка",
                          type: "textarea",
                        },
                      ]}
                      submit="Добавить заметку"
                      onSubmit={(v) =>
                        api(`/work/${t}/customers/${id}/notes`, "POST", v)
                      }
                    />
                    {c.notes.map((n) => (
                      <div className="note" key={n.id}>
                        <p>{n.body}</p>
                        <small>
                          {n.authorName} · {dateTime(n.createdAt)}
                        </small>
                      </div>
                    ))}
                  </section>
                </div>
                <CustomerLoyalty tenantId={t!} customerId={id!} />
                <section className="panel">
                  <h2>История в этом салоне</h2>
                  {c.bookings.length ? (
                    c.bookings.map((b) => (
                      <Link
                        className="history-row"
                        key={b.id}
                        to={`/work/${t}/bookings/${b.id}`}
                      >
                        <span>{dateTime(b.startAt)}</span>
                        <strong>{b.serviceNameSnapshot}</strong>
                        <Badge status={b.status} />
                        <span>
                          {money(
                            (b.priceMinorSnapshot ?? 0) -
                              (b.discountMinor ?? 0),
                          )}
                        </span>
                      </Link>
                    ))
                  ) : (
                    <Empty title="Визитов пока нет" />
                  )}
                </section>
                {edit && (
                  <Modal
                    title="Изменить карточку"
                    onClose={() => setEdit(false)}
                  >
                    <SimpleForm
                      fields={customerFields}
                      initial={{
                        displayName: c.displayName,
                        contact: c.contact,
                        tags: c.tags.join(", "),
                      }}
                      onSubmit={async (v) => {
                        await api(`/work/${t}/customers/${id}`, "PATCH", {
                          ...v,
                          tags: (v.tags ?? "")
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                          expectedVersion: c.version,
                        });
                        setEdit(false);
                      }}
                    />
                  </Modal>
                )}
              </>
            );
          })()}
      </Load>
    </>
  );
}
export function LinkBox({
  url,
  browserUrl,
}: {
  url: string;
  browserUrl: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="link-box">
      <small>Персональная ссылка MAX — передайте нужному человеку:</small>
      <input
        value={url}
        readOnly
        aria-label="Ссылка MAX"
        onFocus={(e) => e.target.select()}
      />
      <button
        className="button secondary compact"
        onClick={() =>
          void navigator.clipboard
            .writeText(url)
            .then(() => setCopied(true))
            .catch(() => {})
        }
      >
        {copied ? "Скопировано" : "Копировать"}
      </button>
      <a href={browserUrl} className="small">
        Открыть в браузере для демо
      </a>
      <small>
        Сначала смените демо-роль на получателя, затем откройте ссылку. Срок
        действия — 24 часа.
      </small>
    </div>
  );
}

export function CatalogPage() {
  const { t } = useParams();
  const services = useApi<Items<Service>>(`/work/${t}/services`),
    staff = useApi<Items<Staff>>(`/work/${t}/staff`),
    categories = useApi<Items<Category>>(`/work/${t}/categories`);
  // A service nobody provides never yields a slot, and the publish checklist only
  // requires one covered service — so the owner needs to see the gap here.
  const uncovered = (serviceId: string) =>
    !!staff.data &&
    !staff.data.items.some(
      (m) => m.active && m.serviceIds.includes(serviceId),
    );
  const [modal, setModal] = useState<"service" | "staff" | "category" | null>(
      null,
    ),
    [selectedService, setSelectedService] = useState<Service>(),
    [selectedStaff, setSelectedStaff] = useState<Staff>(),
    [serviceCover, setServiceCover] = useState<Media>(),
    [staffPhoto, setStaffPhoto] = useState<Media>(),
    [assign, setAssign] = useState<Staff>();
  const [assignment, setAssignment] = useState<string[]>([]);
  const action = useAction();
  const uploadImage = async (purpose: "service" | "staff", file?: File) => {
    if (!file) return;
    const form = new FormData();
    form.append("purpose", purpose);
    form.append("file", file);
    await action.run(async () => {
      const media = await api<Media>(`/work/${t}/media`, "POST", form);
      if (purpose === "service") setServiceCover(media);
      else setStaffPhoto(media);
    }, "Изображение загружено. Сохраните карточку.");
  };
  const fields = [
    { name: "name", label: "Название услуги" },
    {
      name: "description",
      label: "Описание",
      type: "textarea",
      required: false,
    },
    { name: "durationMin", label: "Длительность, минут", type: "number" },
    { name: "price", label: "Цена, рублей", type: "number" },
  ];
  return (
    <>
      <PageTitle
        title="Услуги и мастера"
        description="Изменения цены и длительности применяются к новым записям. Прошлые визиты хранят свои условия."
      />
      <div className="section-head">
        <h2>Каталог услуг</h2>
        <div className="inline-actions">
          <button
            className="button secondary"
            onClick={() => setModal("category")}
          >
            Категория
          </button>
          <button
            className="button primary"
            onClick={() => {
              setSelectedService(undefined);
              setServiceCover(undefined);
              setModal("service");
            }}
          >
            Добавить услугу
          </button>
        </div>
      </div>
      <Load {...services}>
        <div className="service-list">
          {services.data?.items.map((s) => (
            <div className="service-row" key={s.id}>
              {s.coverMediaId && (
                <Asset
                  tenantId={t!}
                  media={{
                    id: s.coverMediaId,
                    fileKey: "",
                    purpose: "service",
                  }}
                  privateAsset
                  className="service-cover"
                  alt={`Обложка услуги «${s.name}»`}
                />
              )}
              <div>
                <h3>
                  {s.name} {!s.active && <Badge status="archived" />}
                  {s.active && uncovered(s.id) && (
                    <span className="badge pending">Никто не оказывает</span>
                  )}
                </h3>
                <p>{s.description}</p>
                <small>{s.durationMin} минут</small>
                {s.active && uncovered(s.id) && (
                  <p className="small muted">
                    Клиенты не увидят свободного времени, пока услугу не
                    назначат мастеру — кнопка «Назначить услуги» в карточке
                    мастера ниже.
                  </p>
                )}
              </div>
              <div>
                <strong>{money(s.priceMinor)}</strong>
                <button
                  className="button secondary compact"
                  onClick={() => {
                    setSelectedService(s);
                    setServiceCover(
                      s.coverMediaId
                        ? { id: s.coverMediaId, fileKey: "", purpose: "service" }
                        : undefined,
                    );
                    setModal("service");
                  }}
                >
                  Изменить
                </button>
                {s.active && (
                  <button
                    className="text-button danger-text"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        () =>
                          api(`/work/${t}/services/${s.id}/archive`, "POST", {
                            expectedVersion: s.version,
                          }),
                        "Услуга архивирована",
                      )
                    }
                  >
                    В архив
                  </button>
                )}
              </div>
            </div>
          ))}
          {!services.data?.items.length && (
            <Empty title="Добавьте первую услугу" />
          )}
        </div>
      </Load>
      <div className="section-head">
        <h2>Мастера</h2>
        <button
          className="button primary"
          onClick={() => {
            setSelectedStaff(undefined);
            setStaffPhoto(undefined);
            setModal("staff");
          }}
        >
          Добавить мастера
        </button>
      </div>
      <Load {...staff}>
        <div className="staff-grid">
          {staff.data?.items.map((s, i) => (
            <section className="panel staff-editor" key={s.id}>
              <div className={`staff-avatar tone-${i % 3}`}>
                {s.photoMediaId ? (
                  <Asset
                    tenantId={t!}
                    media={{ id: s.photoMediaId, fileKey: "", purpose: "staff" }}
                    privateAsset
                    alt={`Фото ${s.name}`}
                  />
                ) : (
                  s.name.charAt(0)
                )}
              </div>
              <h3>{s.name}</h3>
              {!s.active && <Badge status="archived" />}
              <div className="staff-rating">
                {s.ratingCount
                  ? `★ ${s.ratingAverage?.toLocaleString("ru-RU")} · ${plural(s.ratingCount, "оценка", "оценки", "оценок")}`
                  : "Пока нет оценок"}
              </div>
              <p>{s.description}</p>
              <small>{plural(s.serviceIds.length, "услуга", "услуги", "услуг")}</small>
              <div className="stack">
                <button
                  className="button secondary"
                  onClick={() => {
                    setSelectedStaff(s);
                    setStaffPhoto(
                      s.photoMediaId
                        ? { id: s.photoMediaId, fileKey: "", purpose: "staff" }
                        : undefined,
                    );
                    setModal("staff");
                  }}
                >
                  Изменить профиль
                </button>
                <button
                  className="button secondary"
                  onClick={() => {
                    setAssign(s);
                    setAssignment(s.serviceIds);
                  }}
                >
                  Назначить услуги
                </button>
                {s.active && (
                  <button
                    className="text-button danger-text"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        () =>
                          api(`/work/${t}/staff/${s.id}/archive`, "POST", {
                            expectedVersion: s.version,
                          }),
                        "Мастер архивирован",
                      )
                    }
                  >
                    В архив
                  </button>
                )}
              </div>
            </section>
          ))}
        </div>
      </Load>
      {action.feedback}
      {modal && (
        <Modal
          title={
            modal === "service"
              ? selectedService
                ? "Изменить услугу"
                : "Новая услуга"
              : modal === "staff"
                ? selectedStaff
                  ? "Изменить мастера"
                  : "Новый мастер"
                : "Новая категория"
          }
          onClose={() => setModal(null)}
        >
          {modal === "service" ? (
            <SimpleForm
              fields={fields}
              submitDisabled={action.busy}
              initial={
                selectedService
                  ? {
                      name: selectedService.name,
                      description: selectedService.description,
                      durationMin: selectedService.durationMin,
                      price: selectedService.priceMinor / 100,
                    }
                  : { durationMin: 60, price: 1500 }
              }
              onSubmit={async (v) => {
                const body = {
                  name: v.name,
                  description: v.description ?? "",
                  durationMin: Number(v.durationMin),
                  priceMinor: Math.round(Number(v.price) * 100),
                  coverMediaId: serviceCover?.id ?? null,
                  categoryId: v.categoryId || null,
                  active: v.active === "on",
                  ...(selectedService
                    ? { expectedVersion: selectedService.version }
                    : {}),
                };
                await api(
                  `/work/${t}/services${selectedService ? `/${selectedService.id}` : ""}`,
                  selectedService ? "PATCH" : "POST",
                  body,
                );
                setModal(null);
              }}
            >
              <Field
                label="Обложка услуги"
                hint="JPEG, PNG или WebP до 5 МБ. Показывается в витрине."
              >
                <FilePick
                  accept="image/jpeg,image/png,image/webp"
                  disabled={action.busy}
                  label={serviceCover ? "Заменить обложку" : "Добавить обложку"}
                  onPick={(file) => void uploadImage("service", file)}
                />
              </Field>
              <Field label="Категория">
                <select
                  name="categoryId"
                  defaultValue={selectedService?.categoryId ?? ""}
                >
                  <option value="">Без категории</option>
                  {categories.data?.items
                    .filter((c) => !c.archived)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </Field>
              <label className="check">
                <input
                  name="active"
                  type="checkbox"
                  defaultChecked={selectedService?.active ?? true}
                />
                <span>Доступна для новых записей</span>
              </label>
            </SimpleForm>
          ) : modal === "staff" ? (
            <SimpleForm
              submitDisabled={action.busy}
              fields={[
                { name: "name", label: "Имя мастера" },
                {
                  name: "description",
                  label: "Описание",
                  type: "textarea",
                  required: false,
                },
              ]}
              initial={
                selectedStaff
                  ? {
                      name: selectedStaff.name,
                      description: selectedStaff.description,
                    }
                  : {}
              }
              onSubmit={async (v) => {
                await api(
                  `/work/${t}/staff${selectedStaff ? `/${selectedStaff.id}` : ""}`,
                  selectedStaff ? "PATCH" : "POST",
                  {
                    name: v.name,
                    description: v.description ?? "",
                    photoMediaId: staffPhoto?.id ?? null,
                    active: v.active === "on",
                    ...(selectedStaff
                      ? { expectedVersion: selectedStaff.version }
                      : {}),
                  },
                );
                setModal(null);
              }}
            >
              <Field
                label="Фотография мастера"
                hint="Мастер также сможет заменить её в своём кабинете."
              >
                <FilePick
                  accept="image/jpeg,image/png,image/webp"
                  disabled={action.busy}
                  label={staffPhoto ? "Заменить фотографию" : "Добавить фотографию"}
                  onPick={(file) => void uploadImage("staff", file)}
                />
              </Field>
              <label className="check">
                <input
                  type="checkbox"
                  name="active"
                  defaultChecked={selectedStaff?.active ?? true}
                />
                <span>Принимает новые записи</span>
              </label>
            </SimpleForm>
          ) : (
            <SimpleForm
              fields={[
                { name: "name", label: "Название категории" },
                { name: "sortOrder", label: "Порядок", type: "number" },
              ]}
              initial={{ sortOrder: 0 }}
              onSubmit={async (v) => {
                await api(`/work/${t}/categories`, "POST", {
                  name: v.name,
                  sortOrder: Number(v.sortOrder),
                });
                setModal(null);
              }}
            />
          )}
        </Modal>
      )}
      {assign && (
        <Modal
          title={`Услуги · ${assign.name}`}
          onClose={() => setAssign(undefined)}
        >
          {services.data?.items.map((s) => (
            <Check
              key={s.id}
              label={s.name}
              checked={assignment.includes(s.id)}
              onChange={(enabled) =>
                setAssignment(
                  enabled
                    ? [...assignment, s.id]
                    : assignment.filter((id) => id !== s.id),
                )
              }
            />
          ))}
          <button
            className="button primary"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api(`/work/${t}/staff/${assign.id}/services`, "PUT", {
                  expectedVersion: assign.version,
                  serviceIds: assignment,
                });
                setAssign(undefined);
              })
            }
          >
            Сохранить назначения
          </button>
          {action.feedback}
        </Modal>
      )}
    </>
  );
}

const weekNames = [
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
  "Воскресенье",
];
export function SchedulePage() {
  const { t } = useParams();
  const workers = useApi<Items<Staff>>(`/work/${t}/staff`);
  const [staff, setStaff] = useState(""),
    [from, setFrom] = useState(dayISO(1)),
    [weekly, setWeekly] = useState<Weekday[]>([]),
    [exDate, setExDate] = useState(dayISO(1)),
    [exMode, setExMode] = useState("closed"),
    [exStart, setExStart] = useState("10:00"),
    [exEnd, setExEnd] = useState("18:00"),
    [conflict, setConflict] = useState<null | "weekly" | "exception">(null);
  const data = useApi<Schedule>(
    staff ? `/work/${t}/staff/${staff}/schedule` : null,
  );
  const action = useAction();
  useEffect(() => {
    if (!staff && workers.data?.items[0]) setStaff(workers.data.items[0].id);
  }, [workers.data]);
  useEffect(() => {
    const source = data.data?.rules[0]?.weekly ?? [];
    setWeekly(
      Array.from({ length: 7 }, (_, i) => ({
        weekday: i + 1,
        intervals:
          source
            .find((d) => d.weekday === i + 1)
            ?.intervals.map((v) => ({ ...v })) ?? [],
      })),
    );
    setConflict(null);
  }, [data.data?.staff.id, data.data?.staff.version]);
  const update = (weekday: number, intervals: Interval[]) =>
    setWeekly(
      weekly.map((d) => (d.weekday === weekday ? { ...d, intervals } : d)),
    );
  async function save(kind: "weekly" | "exception", confirmConflicts = false) {
    try {
      await api(
        `/work/${t}/staff/${staff}/${kind === "weekly" ? "schedule" : `exceptions/${exDate}`}`,
        "PUT",
        kind === "weekly"
          ? {
              expectedVersion: data.data!.staff.version,
              effectiveFrom: from,
              weekly,
              confirmConflicts,
            }
          : {
              expectedVersion: data.data!.staff.version,
              mode: exMode,
              intervals:
                exMode === "closed"
                  ? []
                  : [{ kind: "work", start: exStart, end: exEnd }],
              confirmConflicts,
            },
      );
      setConflict(null);
    } catch (e) {
      if (
        e &&
        typeof e === "object" &&
        "code" in e &&
        e.code === "SCHEDULE_CONFLICTS"
      )
        setConflict(kind);
      throw e;
    }
  }
  return (
    <>
      <PageTitle
        title="График работы"
        description="Недельные интервалы, перерывы и исключения по датам. Записи не отменяются при изменении графика."
      />
      <div className="filters">
        <Field label="Мастер">
          <select value={staff} onChange={(e) => setStaff(e.target.value)}>
            <option value="">Выберите мастера</option>
            {workers.data?.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Новый график действует с">
          <input
            type="date"
            min={dayISO(1)}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
      </div>
      <Load {...data}>
        {data.data && (
          <>
            <section className="panel">
              <div className="schedule-editor">
                {weekly.map((day) => (
                  <div className="schedule-day" key={day.weekday}>
                    <strong>{weekNames[day.weekday - 1]}</strong>
                    <div>
                      {day.intervals.length ? (
                        day.intervals.map((i, index) => (
                          <div className="interval" key={index}>
                            <select
                              aria-label="Тип интервала"
                              value={i.kind}
                              onChange={(e) =>
                                update(
                                  day.weekday,
                                  day.intervals.map((v, n) =>
                                    n === index
                                      ? {
                                          ...v,
                                          kind: e.target
                                            .value as Interval["kind"],
                                        }
                                      : v,
                                  ),
                                )
                              }
                            >
                              <option value="work">Работа</option>
                              <option value="break">Перерыв</option>
                            </select>
                            <input
                              aria-label="Начало"
                              type="time"
                              value={i.start}
                              onChange={(e) =>
                                update(
                                  day.weekday,
                                  day.intervals.map((v, n) =>
                                    n === index
                                      ? { ...v, start: e.target.value }
                                      : v,
                                  ),
                                )
                              }
                            />
                            <span>—</span>
                            <input
                              aria-label="Конец"
                              type="time"
                              value={i.end}
                              onChange={(e) =>
                                update(
                                  day.weekday,
                                  day.intervals.map((v, n) =>
                                    n === index
                                      ? { ...v, end: e.target.value }
                                      : v,
                                  ),
                                )
                              }
                            />
                            <button
                              className="icon-button"
                              aria-label="Удалить интервал"
                              onClick={() =>
                                update(
                                  day.weekday,
                                  day.intervals.filter((_, n) => n !== index),
                                )
                              }
                            >
                              ×
                            </button>
                          </div>
                        ))
                      ) : (
                        <span className="muted">Выходной</span>
                      )}
                      <button
                        className="text-button"
                        onClick={() =>
                          update(day.weekday, [
                            ...day.intervals,
                            { kind: "work", start: "09:00", end: "18:00" },
                          ])
                        }
                      >
                        + Интервал
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <button
                className="button primary"
                disabled={action.busy}
                onClick={() => void action.run(() => save("weekly"))}
              >
                Сохранить недельный график
              </button>
            </section>
            <section className="panel">
              <h2>Исключение на конкретный день</h2>
              <div className="filters">
                <Field label="Дата">
                  <input
                    type="date"
                    min={dayISO(1)}
                    value={exDate}
                    onChange={(e) => setExDate(e.target.value)}
                  />
                </Field>
                <Field label="Режим">
                  <select
                    value={exMode}
                    onChange={(e) => setExMode(e.target.value)}
                  >
                    <option value="closed">Выходной</option>
                    <option value="replace">Другие часы работы</option>
                  </select>
                </Field>
                {exMode === "replace" && (
                  <>
                    <Field label="С">
                      <input
                        type="time"
                        value={exStart}
                        onChange={(e) => setExStart(e.target.value)}
                      />
                    </Field>
                    <Field label="До">
                      <input
                        type="time"
                        value={exEnd}
                        onChange={(e) => setExEnd(e.target.value)}
                      />
                    </Field>
                  </>
                )}
              </div>
              <button
                className="button secondary"
                disabled={action.busy}
                onClick={() => void action.run(() => save("exception"))}
              >
                Сохранить исключение
              </button>
              {data.data.exceptions.map((ex) => (
                <div className="history-row" key={ex.date}>
                  <strong>{ex.date}</strong>
                  <span>
                    {ex.mode === "closed"
                      ? "Выходной"
                      : ex.intervals
                          .map((i) => `${i.start}–${i.end}`)
                          .join(", ")}
                  </span>
                  <button
                    className="text-button"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(() =>
                        api(
                          `/work/${t}/staff/${staff}/exceptions/${ex.date}`,
                          "DELETE",
                          { expectedVersion: data.data!.staff.version },
                        ),
                      )
                    }
                  >
                    Удалить
                  </button>
                </div>
              ))}
            </section>
          </>
        )}
      </Load>
      {action.feedback}
      {conflict && (
        <div className="notice">
          <p>
            Новый график конфликтует с существующими визитами. Они останутся в
            календаре; переносить или отменять их нужно отдельно.
          </p>
          <button
            className="button secondary"
            disabled={action.busy}
            onClick={() => void action.run(() => save(conflict, true))}
          >
            Понимаю, сохранить график
          </button>
        </div>
      )}
    </>
  );
}

export function AnalyticsPage() {
  const { t } = useParams();
  const [from, setFrom] = useState(`${dayISO().slice(0, 7)}-01`),
    [to, setTo] = useState(dayISO()),
    [staff, setStaff] = useState("");
  const workers = useApi<Items<Staff>>(`/work/${t}/staff`);
  const data = useApi<
    Record<string, number | string | null> & {
      services: { name: string; count: number }[];
    }
  >(`/work/${t}/analytics?from=${from}&to=${to}&staffId=${staff}`, true);
  const percent = (v: unknown) =>
    v == null
      ? "—"
      : `${(Number(v) * 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 })}%`;
  const metrics: [string, string, (v: unknown) => string][] = [
    ["created", "Создано записей", String],
    ["completed", "Завершено визитов", String],
    ["planned", "Подтверждённые", String],
    ["cancelled", "Отмены", String],
    ["noShow", "Неявки", String],
    ["noShowRate", "Доля неявок", percent],
    ["cancellationRate", "Доля отмен", percent],
    ["newCustomers", "Новые клиенты", String],
    ["returningCustomers", "Вернувшиеся клиенты", String],
    ["utilization", "Загрузка", percent],
    ["serviceValueMinor", "Стоимость оказанных услуг", (v) => money(Number(v))],
    [
      "averageVisitMinor",
      "Средняя стоимость визита",
      (v) => (v == null ? "—" : money(Number(v))),
    ],
  ];
  return (
    <>
      <PageTitle
        title="Статистика"
        description="Фактические визиты и текущие статусы. Данные обновляются каждые 5 секунд."
      />
      <div className="filters">
        <Field label="С">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label="По включительно">
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        <Field label="Мастер">
          <select value={staff} onChange={(e) => setStaff(e.target.value)}>
            <option value="">Все мастера</option>
            {workers.data?.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Load {...data}>
        {data.data && (
          <>
            <div className="stats-grid">
              {metrics
                .filter(([key]) => key in data.data!)
                .map(([key, label, format]) => (
                  <div className="stat-card" key={key}>
                    <span>{label}</span>
                    <strong>{format(data.data![key])}</strong>
                  </div>
                ))}
            </div>
            <section className="panel">
              <h2>Оказанные услуги</h2>
              {data.data.services.map((s) => (
                <div className="bar-row" key={s.name}>
                  <span>{s.name}</span>
                  <div>
                    <i
                      style={{
                        width: `${(100 * s.count) / Math.max(1, ...data.data!.services.map((v) => v.count))}%`,
                      }}
                    />
                  </div>
                  <strong>{s.count}</strong>
                </div>
              ))}
              {!data.data.services.length && (
                <Empty title="Нет завершённых визитов" />
              )}
            </section>
            <section className="panel">
              <h3>Как считаем</h3>
              <p>
                Загрузка: занятые минуты подтверждённых, завершённых визитов и
                неявок / доступные минуты графиков с вычетом перерывов. Отмена
                освобождает время. При сокращении графика загрузка может
                превышать 100%.
              </p>
              <p>
                Занято: {String(data.data.occupiedMinutes)} мин. Доступно:{" "}
                {data.data.availableMinutes == null
                  ? "нет исторических данных"
                  : `${data.data.availableMinutes} мин`}
                .
              </p>
              <p>
                Неявки / (завершённые + неявки). Новые клиенты определяются по
                первому завершённому визиту за всю историю салона. Стоимость
                оказанных услуг — сумма завершённых визитов за вычетом скидок,
                это не учёт платежей и не выручка.
              </p>
              <small>
                Расчёт: {dateTime(String(data.data.calculatedAt))} · зона салона{" "}
                {String(data.data.timezone)}
              </small>
            </section>
          </>
        )}
      </Load>
    </>
  );
}
export function AuditPage() {
  const { t } = useParams();
  const [kind, setKind] = useState("");
  const data = useApi<
    Items<{
      id: string;
      action: string;
      actorName: string;
      createdAt: string;
      details: Record<string, unknown>;
    }>
  >(`/work/${t}/audit?limit=100&kind=${kind}`, true);
  return (
    <>
      <PageTitle
        title="Журнал действий"
        description="Кто и когда изменял данные вашего салона."
      />
      <select
        aria-label="Область журнала"
        value={kind}
        onChange={(e) => setKind(e.target.value)}
      >
        <option value="">Все доступные действия</option>
        <option value="booking.">Записи</option>
        <option value="crm.">Клиенты</option>
        <option value="catalog.">Каталог</option>
        <option value="schedule.">Графики</option>
        <option value="campaign.">Партнёрства</option>
        <option value="membership.">Доступ</option>
      </select>
      <Load {...data}>
        <div className="data-list">
          {data.data?.items.map((a) => (
            <div className="audit-row" key={a.id}>
              <span>{dateTime(a.createdAt)}</span>
              <div>
                <strong>{a.action}</strong>
                <p>{a.actorName ?? "Система"}</p>
                {typeof a.details.reason === "string" && (
                  <small>{a.details.reason}</small>
                )}
              </div>
            </div>
          ))}
          {!data.data?.items.length && <Empty title="Действий пока нет" />}
        </div>
      </Load>
    </>
  );
}
