import { useEffect, useState, type CSSProperties } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api, useApi, useAuth, refreshData, currentSession } from "./api";
import { PromotionCards } from './promotions-ui';
import {
  PageTitle,
  Icon,
  Empty,
  Load,
  Field,
  Check,
  Badge,
  money,
  dateTime,
  dayISO,
  SimpleForm,
  useAction,
  BackLink,
  CommandButton,
  plural,
  TimezonePicker,
  timezoneLabel,
} from "./ui";
import type {
  Booking,
  Salon,
  Catalog,
  Items,
  Preference,
  Event,
  Voucher,
  Revocation,
  Style,
  Media,
} from "./types";
export { BookingForm, BookingPage } from "./booking-ui";

export function BookingCard({
  booking: b,
  work = false,
}: {
  booking: Booking;
  work?: boolean;
}) {
  const date = new Date(b.startAt);
  // The salon's own zone, so the card agrees with the slot grid the visit was picked from.
  const zone = b.timezoneSnapshot || "Europe/Moscow";
  return (
    <Link
      to={
        work ? `/work/${b.tenantId}/bookings/${b.id}` : `/me/bookings/${b.id}`
      }
      className="booking-card"
    >
      <div className="date-tile">
        <span>
          {date.toLocaleDateString("ru-RU", {
            month: "short",
            timeZone: zone,
          })}
        </span>
        <strong>
          {date.toLocaleDateString("ru-RU", {
            day: "2-digit",
            timeZone: zone,
          })}
        </strong>
        <small>
          {date.toLocaleTimeString("ru-RU", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: zone,
          })}
        </small>
      </div>
      <div className="booking-card-body">
        <div className="eyebrow">{work ? b.customerName : b.tenantName}</div>
        <h3>{b.serviceNameSnapshot}</h3>
        <p>
          {b.staffName} <span>·</span>{" "}
          {Math.round((new Date(b.endAt).getTime() - date.getTime()) / 60000)}{" "}
          мин
        </p>
        <Badge status={b.status} />
        {!work && b.reviewStatus === "active" && b.reviewRating && (
          <span className="booking-rating" aria-label={`Оценка ${b.reviewRating} из 5`}>
            ★ {b.reviewRating}/5
          </span>
        )}
        {!work && b.canReview && !b.reviewRating && (
          <span className="booking-rating pending">Оценить мастера</span>
        )}
      </div>
      <div className="booking-card-end">
        {b.totalMinor !== undefined && <strong>{money(b.totalMinor)}</strong>}
        <span className="circle-arrow">
          <Icon name="arrow" size={16} />
        </span>
      </div>
    </Link>
  );
}
export function BookingsPage() {
  const { me } = useAuth();
  const [state, setState] = useState("upcoming"),
    [tenant, setTenant] = useState(""),
    [day, setDay] = useState("");
  const data = useApi<Items<Booking>>(
    `/me/bookings?limit=100&state=${state}${tenant ? `&tenantId=${tenant}` : ""}${day ? `&from=${day}T00:00:00%2B03:00&to=${day}T23:59:59%2B03:00` : ""}`,
    true,
  );
  const salons = useApi<Items<Salon>>("/me/salons");
  return (
    <>
      <PageTitle
        eyebrow="ХОРОШИЙ ДЕНЬ НАЧИНАЕТСЯ С ЗАБОТЫ О СЕБЕ"
        title={`Ваши планы, ${me?.user.displayName.split(" ")[0] ?? ""}`}
        description="Все записи в любимые салоны — в одном месте."
        action={
          <Link className="button primary" to="/me/salons">
            <Icon name="plus" />
            Новая запись
          </Link>
        }
      />
      <div className="welcome-banner">
        <div>
          <span className="eyebrow">В ВАШЕМ РИТМЕ</span>
          <h2>Найдите время для себя</h2>
          <p>
            Выберите салон, мастера и удобное время.
            <br />
            Остальное мы сохраним в вашем календаре.
          </p>
          <Link to="/me/salons">
            Посмотреть салоны <Icon name="arrow" size={15} />
          </Link>
        </div>
        <div className="banner-art" aria-hidden="true">
          <div className="art-ring" />
          <div className="art-ticket">
            <span>ВАШЕ ВРЕМЯ</span>
            <strong>для себя ✦</strong>
            <i>рядом</i>
          </div>
          <span className="art-star">✳</span>
        </div>
      </div>
      <div className="section-head">
        <div className="tabs">
          <button
            className={state === "upcoming" ? "selected" : ""}
            onClick={() => setState("upcoming")}
          >
            Предстоящие
          </button>
          <button
            className={state === "history" ? "selected" : ""}
            onClick={() => setState("history")}
          >
            История
          </button>
        </div>
        <select
          aria-label="Фильтр по салону"
          value={tenant}
          onChange={(e) => setTenant(e.target.value)}
        >
          <option value="">Все салоны</option>
          {salons.data?.items.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="day-strip">
        <button className={!day ? "selected" : ""} onClick={() => setDay("")}>
          Все
          <br />
          <strong>дни</strong>
        </button>
        {Array.from({ length: 7 }, (_, i) => {
          const d = dayISO(i);
          return (
            <button
              key={d}
              className={day === d ? "selected" : ""}
              onClick={() => setDay(d)}
            >
              <span>
                {new Date(`${d}T12:00`).toLocaleDateString("ru-RU", {
                  weekday: "short",
                })}
              </span>
              <strong>{d.slice(-2)}</strong>
            </button>
          );
        })}
        <input
          aria-label="Выбрать дату"
          type="date"
          value={day}
          onChange={(e) => setDay(e.target.value)}
        />
      </div>
      <Load {...data}>
        {data.data?.items.length ? (
          <div className="booking-grid">
            {data.data.items.map((b) => (
              <BookingCard key={b.id} booking={b} />
            ))}
          </div>
        ) : (
          <Empty
            title={
              state === "upcoming"
                ? "Пока нет предстоящих записей"
                : "Визитов за этот период нет"
            }
            text="Запишитесь на удобное время — визит появится здесь."
            action={
              <Link className="button secondary" to="/me/salons">
                Выбрать салон
              </Link>
            }
          />
        )}
      </Load>
      <div className="hint-row">
        <Icon name="bell" />
        <span>
          Напоминания настраиваются отдельно для каждого салона в профиле.
        </span>
        <Link to="/me/profile">Настроить →</Link>
      </div>
    </>
  );
}
export function SalonCard({ salon: s }: { salon: Salon }) {
  const style = s.style ?? s.publishedStyle;
  return (
    <Link
      to={`/s/${s.publicCode}`}
      className={`salon-card accent-${style?.accent ?? "violet"}`}
    >
      <div className="salon-cover">
        <Asset
          tenantId={s.id}
          media={s.media?.find((m) => m.id === style?.coverMediaId)}
          className="cover-image"
          alt=""
        />
        <span className="salon-monogram">{s.name.split(" ·")[0]}</span>
        <span className="salon-symbol">✳</span>
        <span className="category-chip">{s.category ?? "Ваш салон"}</span>
      </div>
      <div className="salon-card-info">
        {style?.logoMediaId && (
          <span className="salon-card-logo">
            <Asset
              tenantId={s.id}
              media={s.media?.find((m) => m.id === style.logoMediaId)}
              alt=""
            />
          </span>
        )}
        <div>
          <h3>{s.name}</h3>
          <p>{s.address ?? "Откройте витрину салона"}</p>
        </div>
        <span className="circle-arrow">
          <Icon name="arrow" size={16} />
        </span>
      </div>
    </Link>
  );
}
export function DiscoverPage() {
  const [query, setQuery] = useState("");
  const [showCatalog, setShowCatalog] = useState(false);
  const search = query.trim();
  const publicData = useApi<Items<Salon>>(
    search || showCatalog ? `/public/salons?query=${encodeURIComponent(search)}` : null,
  );
  const mine = useApi<Items<Salon>>("/me/salons");
  const familiar = [...(mine.data?.items ?? [])].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite));
  const discover = publicData.data?.items ?? [];
  return (
    <>
      <PageTitle
        eyebrow="РЯДОМ · ВАШЕ ВРЕМЯ ДЛЯ СЕБЯ"
        title="Мои места"
        description="Знакомые салоны и всё, что связано с ними. Найдите другое место по названию или услуге."
      />
      <div className="search-box place-search">
        <Icon name="search" />
        <input
          aria-label="Поиск салона"
          type="search"
          placeholder="Салон, услуга или ключевое слово"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {search || showCatalog ? (
        <>
          <div className="section-head">
            <h2>{search ? "Результаты поиска" : "Каталог салонов"}</h2>
            <button className="text-button" onClick={() => {setQuery("");setShowCatalog(false);}}>К моим местам</button>
          </div>
          <Load {...publicData}>
            {discover.length ? <div className="salon-grid">{discover.map((s) => <SalonCard key={s.id} salon={s} />)}</div>
              : <Empty title={search ? "Место не найдено" : "Каталог пока пуст"} text={search ? "Попробуйте другое название, услугу или адрес." : "Новые опубликованные салоны появятся здесь."} />}
          </Load>
        </>
      ) : <Load {...mine}>
        {familiar.length ? <>
          <div className="section-head"><h2>Знакомое место</h2></div>
          <div className="familiar-feature"><SalonCard salon={familiar[0]!} /></div>
          {familiar.length > 1 && <><div className="section-head"><h2>Остальные мои места</h2></div>
            <div className="salon-grid">{familiar.slice(1).map((s) => <SalonCard key={s.id} salon={s} />)}</div></>}
        </> : <Empty title="Здесь появится ваше место" text="Найдите салон по названию или услуге и сохраните его. После визита он тоже появится здесь." />}
        <button className="button secondary" onClick={() => setShowCatalog(true)}>Открыть каталог салонов</button>
      </Load>}
    </>
  );
}
export function Asset({
  tenantId,
  media,
  privateAsset = false,
  className = "",
  alt = "",
}: {
  tenantId: string;
  media?: Media;
  privateAsset?: boolean;
  className?: string;
  alt?: string;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let alive = true,
      local = "";
    if (!media) {
      setUrl("");
      return;
    }
    if (!privateAsset) {
      setUrl(`/media/${media.fileKey}`);
      return;
    }
    void fetch(`/api/v1/work/${tenantId}/media/${media.id}`, {
      headers: { Authorization: `Bearer ${currentSession()}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.blob();
      })
      .then((blob) => {
        local = URL.createObjectURL(blob);
        if (alive) setUrl(local);
      })
      .catch(() => setUrl(""));
    return () => {
      alive = false;
      if (local) URL.revokeObjectURL(local);
    };
  }, [tenantId, media?.id, privateAsset]);
  return url ? <img src={url} className={className} alt={alt} /> : null;
}
export function StorefrontView({
  salon: s,
  catalog,
  preview = false,
}: {
  salon: Salon;
  catalog?: Catalog;
  preview?: boolean;
}) {
  const theme = s.style ?? s.draftStyle;
  const accent = theme?.accent ?? "violet";
  return (
    <div className={`storefront accent-${accent}`}>
      <div className="storefront-cover">
        <Asset
          tenantId={s.id}
          media={s.media?.find((m) => m.id === theme?.coverMediaId)}
          privateAsset={preview}
          className="cover-image"
          alt="Обложка салона"
        />
        <span className="cover-word">{s.name.split(" ·")[0]}</span>
        <span className="cover-flower" aria-hidden="true">
          ✳
        </span>
        <span className="category-chip">{s.category}</span>
      </div>
      <div className="storefront-intro">
        <div className="salon-logo">
          <Asset
            tenantId={s.id}
            media={s.media?.find((m) => m.id === theme?.logoMediaId)}
            privateAsset={preview}
            alt="Логотип"
          />
          {!theme?.logoMediaId && s.name.charAt(0)}
        </div>
        <div>
          <h1>{s.name}</h1>
          <p>{s.address}</p>
        </div>
        {!preview && (
          <Link className="button primary" to={`/s/${s.publicCode}/book`}>
            Записаться <Icon name="arrow" size={16} />
          </Link>
        )}
      </div>
      <p className="salon-description">{theme?.description}</p>
      <div className="contact-line">
        <span>✦ {s.contact}</span>
        <span>Часовой пояс: {timezoneLabel(s.timezone)}</span>
      </div>
      {catalog && (
        <>
          <div className="section-head">
            <h2>Услуги</h2>
            <span className="muted">Оплата в салоне</span>
          </div>
          <div className="service-list">
            {[...catalog.services]
              .sort((a, b) => {
                const order = theme.categoryOrder ?? [];
                return (
                  order.indexOf(a.categoryId ?? "") -
                  order.indexOf(b.categoryId ?? "")
                );
              })
              .map((v) => (
                <div className="service-row" key={v.id}>
                  {v.coverMediaId && (
                    <Asset
                      tenantId={s.id}
                      media={s.media?.find((m) => m.id === v.coverMediaId)}
                      className="service-cover"
                      alt={`Обложка услуги «${v.name}»`}
                    />
                  )}
                  <div>
                    <h3>{v.name}</h3>
                    <p>{v.description}</p>
                    <small>{v.durationMin} минут</small>
                  </div>
                  <div>
                    <strong>{money(v.priceMinor)}</strong>
                    {!preview && (
                      <Link
                        className="button secondary compact"
                        to={`/s/${s.publicCode}/book?service=${v.id}`}
                      >
                        Выбрать
                      </Link>
                    )}
                  </div>
                </div>
              ))}
          </div>
          <h2>Ваши мастера</h2>
          <div className="staff-grid">
            {catalog.staff.map((st, i) => (
              <div className="staff-card" key={st.id}>
                <div className={`staff-avatar tone-${i % 3}`}>
                  {st.photoMediaId ? (
                    <Asset
                      tenantId={s.id}
                      media={s.media?.find((m) => m.id === st.photoMediaId)}
                      alt={`Фото ${st.name}`}
                    />
                  ) : (
                    st.name.charAt(0)
                  )}
                </div>
                <h3>{st.name}</h3>
                {st.ratingAverage != null && st.ratingCount != null && (
                  <div className="staff-rating" aria-label={`Рейтинг ${st.ratingAverage} из 5, ${st.ratingCount} оценок`}>
                    ★ {st.ratingAverage.toLocaleString("ru-RU")} · {plural(st.ratingCount, "оценка", "оценки", "оценок")}
                  </div>
                )}
                <p>{st.description}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
export function SalonPage() {
  const { code } = useParams();
  const [section, setSection] = useState<"services" | "visits" | "bonuses">("services");
  const data = useApi<Salon>(`/public/salons/${code}`),
    catalog = useApi<Catalog>(`/public/salons/${code}/catalog`),
    mine = useApi<Items<Salon>>("/me/salons");
  const visits = useApi<Items<Booking>>(section === "visits" && data.data ? `/me/bookings?limit=100&tenantId=${data.data.id}` : null);
  const programs = useApi<Items<{id:string;publicCode:string;name:string;serviceName:string;progress:number;visitsRequired:number;availableRewards:number}>>(section === "bonuses" ? "/me/loyalty" : null);
  const rewards = useApi<Items<{id:string;publicCode:string;programName:string;serviceId:string;serviceName:string;status:string}>>(section === "bonuses" ? "/me/loyalty-rewards" : null);
  const action = useAction();
  const favorite = mine.data?.items.some(
    (s) => s.id === data.data?.id && s.favorite,
  );
  return (
    <>
      <div className="section-head">
        <BackLink to="/me/salons" label="Все салоны" />
        {data.data && (
          <button
            className={`button secondary ${favorite ? "favorite" : ""}`}
            disabled={action.busy}
            onClick={() =>
              void action.run(
                () =>
                  api(
                    `/me/favorites/${data.data!.id}`,
                    favorite ? "DELETE" : "PUT",
                    {},
                  ),
                favorite ? "Удалено из избранного" : "Салон сохранён",
              )
            }
          >
            <Icon name="star" />
            {favorite ? "В избранном" : "Сохранить"}
          </button>
        )}
      </div>
      {action.feedback}
      <Load {...data}>
        {data.data && <>
          <div className="salon-context-tabs" role="tablist" aria-label="Разделы салона">
            {([ ["services", "Услуги и мастера"], ["visits", "Визиты"], ["bonuses", "Бонусы и акции"] ] as const).map(([value, label]) =>
              <button key={value} role="tab" aria-selected={section === value} className={section === value ? "selected" : ""} onClick={() => setSection(value)}>{label}</button>)}
          </div>
          {section === "services" && <StorefrontView salon={data.data} catalog={catalog.data} />}
          {section === "visits" && <Load {...visits}>{visits.data?.items.length
            ? <div className="booking-grid">{visits.data.items.map((booking) => <BookingCard key={booking.id} booking={booking} />)}</div>
            : <Empty title="В этом салоне пока нет визитов" text="Выберите услугу и удобное время, чтобы создать первую запись." />}
            <Link className="button primary" to={`/s/${code}/book`}>Записаться в {data.data.name}</Link>
          </Load>}
          {section === "bonuses" && <section className="panel"><h2>Выгоды в {data.data.name}</h2>
            <Load loading={programs.loading || rewards.loading} error={programs.error || rewards.error}>
              {programs.data?.items.filter((program) => program.publicCode === code).map((program) => <div className="history-row" key={program.id}><div><strong>{program.name}</strong><p>{program.serviceName} · {program.progress} из {program.visitsRequired} посещений · наград: {program.availableRewards}</p></div></div>)}
              {rewards.data?.items.filter((reward) => reward.publicCode === code && reward.status === "issued").map((reward) => <div className="history-row" key={reward.id}><div><strong>{reward.programName}</strong><p>{reward.serviceName} · награда доступна для записи</p></div><Link to={`/s/${code}/book?service=${reward.serviceId}&reward=${reward.id}`}>Использовать</Link></div>)}
              {!programs.data?.items.some((program) => program.publicCode === code) && !rewards.data?.items.some((reward) => reward.publicCode === code) && <Empty title="Бонусов пока нет" text="Если салон запустит программу, её условия появятся здесь." />}
            </Load>
            <div className="inline-actions"><Link className="button primary" to="/me/loyalty">Все бонусы</Link><Link className="button secondary" to="/me/offers">Акции и предложения</Link></div>
          </section>}
        </>}
      </Load>
    </>
  );
}
export function EventsPage() {
  const navigate = useNavigate();
  const [tenant, setTenant] = useState(""),
    [kind, setKind] = useState(""),
    [read, setRead] = useState("");
  const data = useApi<Items<Event>>(
    `/me/notifications?limit=100&tenantId=${tenant}&kind=${kind}&read=${read}`,
    true,
  );
  const salons = useApi<Items<Salon>>("/me/salons");
  const a = useAction();
  return (
    <>
      <PageTitle
        eyebrow="НИЧЕГО ВАЖНОГО НЕ ПОТЕРЯЕТСЯ"
        title="События"
        description="Изменения записей и предложения всех ваших салонов."
      />
      <div className="filters">
        <select
          aria-label="Салон"
          value={tenant}
          onChange={(e) => setTenant(e.target.value)}
        >
          <option value="">Все салоны</option>
          {salons.data?.items.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Тип события"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">Все события</option>
          <option value="booking.">Записи</option>
          <option value="loyalty.">Лояльность</option>
          <option value="voucher.">Купоны</option>
          <option value="campaign.">Партнёрства</option>
        </select>
        <select
          aria-label="Прочтение"
          value={read}
          onChange={(e) => setRead(e.target.value)}
        >
          <option value="">Все</option>
          <option value="unread">Непрочитанные</option>
          <option value="read">Прочитанные</option>
        </select>
      </div>
      {a.feedback}
      <Load {...data}>
        {data.data?.items.length ? (
          <div className="event-list">
            {data.data.items.map((e) => (
              <article
                className={`event-row ${e.readAt ? "" : "unread"}`}
                key={e.id}
              >
                <span className="event-icon">
                  <Icon name={e.kind.startsWith("voucher") ? "gift" : "bell"} />
                </span>
                <div>
                  <div className="eyebrow">
                    {e.tenantName ?? "Салоны в MAX"} · {dateTime(e.createdAt)}
                  </div>
                  <h3>{e.title}</h3>
                  <p>{e.body}</p>
                  <div className="inline-actions">
                    {e.objectId && e.kind.startsWith("booking.") && (
                      <button
                        className="text-button"
                        disabled={a.busy}
                        onClick={() =>
                          void a.run(async () => {
                            const target = await api<{ path: string }>(
                              "/launch/resolve",
                              "POST",
                              { payload: `b_${e.objectId}` },
                            );
                            navigate(target.path);
                          }, "")
                        }
                      >
                        Открыть запись
                      </button>
                    )}
                    {e.kind.startsWith("loyalty.") && (
                      <Link to="/me/loyalty">Открыть бесплатные визиты</Link>
                    )}
                    {e.kind.startsWith("voucher.") && (
                      <Link to="/me/offers">Открыть предложения</Link>
                    )}
                    {!e.readAt && (
                      <button
                        className="text-button"
                        disabled={a.busy}
                        onClick={() =>
                          void a.run(
                            () =>
                              api(`/me/notifications/${e.id}/read`, "PUT", {}),
                            "Отмечено прочитанным",
                          )
                        }
                      >
                        Прочитано
                      </button>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty
            title="Пока нет событий"
            text="Подтверждения записей и изменения появятся здесь, даже если сообщения бота отключены."
          />
        )}
      </Load>
    </>
  );
}
export function OffersPage() {
  const [status, setStatus] = useState("");
  const data = useApi<Items<Voucher> & { revocationRequests: Revocation[] }>(
    `/me/vouchers?status=${status}`,
    true,
  );
  return (
    <>
      <PageTitle
        eyebrow="МАЛЕНЬКИЕ ПРИЯТНЫЕ ПОВОДЫ"
        title="Предложения для вас"
        description="Партнёрские награды и временные акции салонов."
      />
      <PromotionCards/>
      <div className="notice">
        Купон выдаётся после платного визита, если вы заранее согласились с действующей версией партнёрской программы. Согласия настраиваются в разделе «Лояльность».
      </div>
      <select
        aria-label="Статус купона"
        value={status}
        onChange={(e) => setStatus(e.target.value)}
      >
        <option value="">Все статусы</option>
        {["issued", "reserved", "redeemed", "expired", "revoked"].map((s) => (
          <option key={s} value={s}>
            {
              (
                {
                  issued: "Доступные",
                  reserved: "В записи",
                  redeemed: "Использованные",
                  expired: "Истёкшие",
                  revoked: "Отозванные",
                } as Record<string, string>
              )[s]
            }
          </option>
        ))}
      </select>
      <Load {...data}>
        {data.data?.revocationRequests.map((r) => (
          <section className="panel" key={r.id}>
            <h2>Изменение скидки требует вашего решения</h2>
            <p>{r.reason}</p>
            <p>
              Сейчас: <strong>{money(r.oldTotalMinor)}</strong>. После согласия:{" "}
              <strong>{money(r.newTotalMinor)}</strong>.
            </p>
            <div className="inline-actions">
              <CommandButton
                path={`/me/voucher-revocation-requests/${r.id}/respond`}
                body={{
                  expectedVersion: r.version,
                  expectedBookingVersion: r.bookingVersion,
                  accept: false,
                }}
                label="Сохранить скидку"
              />
              <CommandButton
                path={`/me/voucher-revocation-requests/${r.id}/respond`}
                body={{
                  expectedVersion: r.version,
                  expectedBookingVersion: r.bookingVersion,
                  accept: true,
                }}
                label="Согласен на новую цену"
              />
            </div>
          </section>
        ))}
        {data.data?.items.length ? (
          <div className="offer-grid">
            {data.data.items.map((v) => (
              <article className="offer-card" key={v.id}>
                <div className="section-head">
                  <span className="eyebrow">ОТ {v.sourceName}</span>
                  <Badge status={v.status} />
                </div>
                <div className="offer-amount">{v.rewardType==='percent'?`−${v.discountPercent}%`:v.rewardType==='free_visits'?`${v.remainingVisits} бесплатн. посещ.`:`−${money(v.discountMinor)}`}</div>
                <h3>{v.targetName}</h3>
                <p>{v.termsSnapshot.termsText}</p>
                <small>{v.expiresAt?`Действует до ${dateTime(v.expiresAt)}`:'Без срока'}</small>
                {v.status === "issued" && (
                  <Link
                    className="button primary"
                    to={`/s/${v.targetCode}/book?voucher=${v.id}`}
                  >
                    Записаться с купоном
                  </Link>
                )}
              </article>
            ))}
          </div>
        ) : (
          <Empty
            title="Предложения появятся здесь"
            text="Откройте раздел лояльности и подтвердите условия нужной партнёрской программы до визита."
            action={
              <Link to="/me/profile" className="button secondary">
                Настройки участия
              </Link>
            }
          />
        )}
      </Load>
    </>
  );
}
function SalonPreferences({ salon }: { salon: Salon }) {
  const data = useApi<Preference>(`/me/salons/${salon.id}/preferences`);
  const [prefs, setPrefs] = useState<Preference>();
  const a = useAction();
  useEffect(() => setPrefs(data.data), [data.data]);
  return (
    <section className="panel">
      <h3>{salon.name}</h3>
      <Load {...data}>
        {prefs && (
          <>
            <Check
              label="Сообщения бота об изменениях записи"
              checked={prefs.serviceBotEnabled}
              onChange={(v) => setPrefs({ ...prefs, serviceBotEnabled: v })}
            />
            <Check
              label="Напоминания за 24 и 2 часа"
              checked={prefs.reminderBotEnabled}
              onChange={(v) => setPrefs({ ...prefs, reminderBotEnabled: v })}
            />
            <Check
              label="Разрешить сообщения MAX о купонах этого салона"
              checked={prefs.partnerAllowed}
              onChange={(v) => setPrefs({ ...prefs, partnerAllowed: v })}
            />
            <Check
              label="Сообщения бота о новых купонах"
              checked={prefs.offerBotEnabled}
              onChange={(v) => setPrefs({ ...prefs, offerBotEnabled: v })}
            />
            {a.feedback}
            <button
              className="button secondary"
              disabled={a.busy}
              onClick={() =>
                void a.run(() =>
                  api(`/me/salons/${salon.id}/preferences`, "PATCH", {
                    expectedVersion: prefs.version,
                    partnerAllowed: prefs.partnerAllowed,
                    serviceBotEnabled: prefs.serviceBotEnabled,
                    reminderBotEnabled: prefs.reminderBotEnabled,
                    offerBotEnabled: prefs.offerBotEnabled,
                    textVersion: "p0-v1",
                  }),
                )
              }
            >
              Сохранить настройки
            </button>
          </>
        )}
      </Load>
    </section>
  );
}
export function ProfilePage() {
  const auth = useAuth();
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  const selectTheme = (value: "light" | "dark") => {
    setTheme(value);
    document.documentElement.dataset.theme = value;
    try { localStorage.setItem("ryadom-theme", value); } catch { /* Storage may be unavailable in a WebView. */ }
  };
  const data = useApi<Items<Salon>>("/me/salons");
  const all = useApi<Items<Salon>>("/public/salons");
  const a = useAction();
  const salons = [
    ...(data.data?.items ?? []),
    ...(all.data?.items ?? []),
  ].filter((v, i, s) => s.findIndex((t) => t.id === v.id) === i);
  return (
    <>
      <PageTitle
        title="Профиль и уведомления"
        description="Вы решаете, какие сообщения получать и в каких программах участвовать."
      />
      <section className="panel profile-theme"><h2>Тема оформления</h2>
        <div className="theme-options" role="group" aria-label="Тема оформления">
          <button type="button" aria-pressed={theme === "light"} className={theme === "light" ? "selected" : ""} onClick={() => selectTheme("light")}><span aria-hidden="true">☀</span> Светлая</button>
          <button type="button" aria-pressed={theme === "dark"} className={theme === "dark" ? "selected" : ""} onClick={() => selectTheme("dark")}><span aria-hidden="true">☾</span> Тёмная</button>
        </div>
      </section>
      <div className="profile-links"><Link to="/me/events">События</Link><Link to="/me/waitlist">Запросы «Живого окна»</Link><Link to="/me/offers">Предложения</Link><Link to="/create-salon">Создать салон</Link></div>
      {!!auth.me?.memberships.length && <section className="panel"><h2>Рабочие кабинеты</h2><div className="profile-links">{auth.me.memberships.map((membership) => <Link key={membership.id} to={`/work/${membership.tenantId}/calendar`}>{membership.tenantName} · {membership.role === "owner" ? "владелец" : membership.role === "admin" ? "администратор" : "мастер"}</Link>)}</div></section>}
      <div className="two-columns">
        <section className="panel">
          <h2>Ваш профиль</h2>
          <SimpleForm
            key={auth.me?.user.version}
            fields={[{ name: "displayName", label: "Имя" }]}
            initial={{ displayName: auth.me!.user.displayName }}
            onSubmit={async (v) => {
              await api("/me/profile", "PATCH", {
                displayName: v.displayName,
                expectedVersion: auth.me!.user.version,
              });
              await auth.reload();
            }}
          />
          <hr />
          <p>
            Канал бота: <Badge status={auth.me!.channel.state} />
          </p>
          <a
            href={`https://max.ru/${auth.botName}`}
            target="_blank"
            rel="noreferrer"
            className="button secondary"
          >
            Открыть бота MAX
          </a>
          <p className="small muted">
            Вход в приложение не возобновляет остановленного бота. Запустите его
            в диалоге.
          </p>
        </section>
        <section className="panel">
          <h2>Партнёрская программа</h2>
          <p>
            После визита можно получить персональный купон другого салона, если принять его действующие условия в разделе лояльности.
            Контакты и CRM-заметки партнёрам не передаются.
          </p>
          <Check
            label="Разрешить сообщения MAX о партнёрских предложениях"
            checked={auth.me!.user.partnerProgramEnabled}
            disabled={a.busy}
            onChange={(enabled) =>
              void a.run(async () => {
                await api("/me/preferences", "PATCH", {
                  partnerProgramEnabled: enabled,
                  textVersion: "p0-v1",
                  expectedVersion: auth.me!.user.version,
                });
                await auth.reload();
              })
            }
          />
          {a.feedback}
          <p className="small muted">
            Это настройка сообщений бота. Согласие на выдачу купонов даётся отдельно для каждой версии программы в разделе «Лояльность». Уже выданные купоны сохраняются при отказе.
          </p>
          <hr />
          <h3>Обработка данных</h3>
          <p className="small">
            Имя MAX используется для записи. Каждый салон видит только свою
            историю. Дополнительный контакт необязателен. Демо содержит
            синтетические данные; сроки хранения реального пилота определяет
            оператор.
          </p>
        </section>
      </div>
      <h2>Настройки по салонам</h2>
      <div className="two-columns">
        {salons.map((s) => (
          <SalonPreferences key={s.id} salon={s} />
        ))}
      </div>
      <section className="panel">
        <h3>Тариф и оплата</h3>
        <p>
          Демонстрационная версия платформы бесплатна. Цена в каталоге
          справочная; услуги оплачиваются непосредственно в салоне.
          Онлайн-оплата, баллы и платная подписка в этой версии не подключены.
        </p>
      </section>
    </>
  );
}
export function CreateSalonPage() {
  const auth = useAuth(),
    navigate = useNavigate();
  return (
    <>
      <PageTitle
        eyebrow="ВАШ БИЗНЕС В MAX"
        title="Создать салон"
        description="Одно пространство для ваших услуг, мастеров и клиентов. Начните с профиля."
      />
      <section className="panel narrow">
        <SimpleForm
          fields={[
            { name: "name", label: "Название салона" },
            {
              name: "category",
              label: "Направление",
              hint: "Например: студия волос, ногтевой сервис",
            },
            { name: "address", label: "Адрес или место оказания услуг" },
            { name: "contact", label: "Публичный способ связи" },
          ]}
          submit="Создать пространство"
          onSubmit={async (v) => {
            const t = await api<Salon>("/tenants", "POST", v);
            await auth.reload();
            navigate(`/work/${t.id}/settings`);
          }}
        >
          <TimezonePicker />
        </SimpleForm>
      </section>
    </>
  );
}
export function InvitePage() {
  const { token } = useParams();
  const [data, setData] = useState<{
      tenantName: string;
      kind: string;
      role: string;
      status: string;
    }>(),
    [error, setError] = useState("");
  const auth = useAuth();
  const a = useAction();
  useEffect(() => {
    void api<typeof data>("/invites/inspect", "POST", { token })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [token]);
  return (
    <>
      <PageTitle title="Приглашение" />
      <section className="panel narrow">
        {error && <div className="notice error">{error}</div>}
        {data && (
          <>
            <h2>{data.tenantName}</h2>
            <p>
              {data.kind === "staff"
                ? `Вас приглашают в рабочий кабинет. Роль: ${data.role === "admin" ? "администратор" : "мастер"}.`
                : "Подтвердите, что ручная карточка этого салона принадлежит вам. Сотрудник салона затем проверит привязку. До этого история недоступна."}
            </p>
            <p>
              Аккаунт: <strong>{auth.me!.user.displayName}</strong>
            </p>
            {a.feedback}
            <button
              className="button primary"
              disabled={a.busy || !!a.success}
              onClick={() =>
                void a.run(
                  async () => {
                    await api("/invites/accept", "POST", {
                      token,
                      explicitConfirmation: true,
                    });
                    await auth.reload();
                  },
                  data.kind === "staff"
                    ? "Доступ получен. Выберите салон в меню пространства."
                    : "Подтверждение отправлено. Ожидается проверка сотрудника.",
                )
              }
            >
              Подтвердить
            </button>
          </>
        )}
      </section>
    </>
  );
}
