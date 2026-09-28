import { useEffect, useState, type CSSProperties } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api, useApi, useAuth, refreshData, currentSession } from "./api";
import { normalizeStyle } from "./storefront-style";
import { storefrontTokenStyle } from "./storefront-tokens";
import {
  PageTitle,
  Modal,
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
  const publicData = useApi<Items<Salon>>(
    `/public/salons?query=${encodeURIComponent(query)}`,
  );
  const mine = useApi<Items<Salon>>("/me/salons");
  // Salons already listed under «Вы уже знакомы» must not appear again in the discovery row.
  const known = new Set(mine.data?.items.map((s) => s.id) ?? []);
  const discover = (publicData.data?.items ?? []).filter(
    (s) => !!query || !known.has(s.id),
  );
  return (
    <>
      <PageTitle
        eyebrow="МЕСТА, К КОТОРЫМ ХОЧЕТСЯ ВОЗВРАЩАТЬСЯ"
        title="Ваши салоны"
        description="Сохраняйте любимые места и находите новые."
      />
      <div className="search-box">
        <Icon name="search" />
        <input
          aria-label="Поиск салона"
          placeholder="Название салона или код"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {!query && !!mine.data?.items.length && (
        <>
          <div className="section-head">
            <h2>Вы уже знакомы</h2>
            <span className="muted">Избранное и ваши визиты</span>
          </div>
          <div className="salon-grid">
            {mine.data.items.map((s) => (
              <SalonCard key={s.id} salon={s} />
            ))}
          </div>
        </>
      )}
      <div className="section-head">
        <h2>{query ? "Результаты поиска" : "Открывайте новое"}</h2>
        <span className="muted">
          {publicData.data
            ? plural(discover.length, "салон", "салона", "салонов")
            : "…"}
        </span>
      </div>
      <Load {...publicData}>
        {discover.length ? (
          <div className="salon-grid">
            {discover.map((s) => (
              <SalonCard key={s.id} salon={s} />
            ))}
          </div>
        ) : (
          <Empty
            title={query ? "Салон не найден" : "Новых салонов пока нет"}
            text={
              query
                ? "Проверьте название или используйте персональную ссылку салона."
                : "Вы уже знакомы со всеми салонами, которые сейчас открыты."
            }
          />
        )}
      </Load>
    </>
  );
}
export function Asset({
  tenantId,
  media,
  privateAsset = false,
  className = "",
  alt = "",
  style,
}: {
  tenantId: string;
  media?: Media;
  privateAsset?: boolean;
  className?: string;
  alt?: string;
  style?: CSSProperties;
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
  return url ? (
    <img src={url} className={className} alt={alt} style={style} />
  ) : null;
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
  const auth = useAuth();
  const theme = normalizeStyle(s.style ?? s.draftStyle);
  const [galleryOpen, setGalleryOpen] = useState<number | null>(null);
  const useV2 = auth.storefrontThemesV2;
  const accent = theme.accent;
  const section = {
    services: catalog ? (
      <section className="storefront-section" key="services">
        <div className="section-head">
          <h2>Услуги</h2>
          <span className="muted">Оплата в салоне</span>
        </div>
        <div className={`service-list service-list-${useV2 ? theme.serviceCards.variant : "compact"}`}>
          {[...catalog.services]
            .sort((a, b) => {
              const order = theme.categoryOrder;
              return (
                order.indexOf(a.categoryId ?? "") -
                order.indexOf(b.categoryId ?? "")
              );
            })
            .map((service) => (
              <article className="service-row" key={service.id}>
                {service.coverMediaId ? (
                  <Asset
                    tenantId={s.id}
                    media={s.media?.find(
                      (media) => media.id === service.coverMediaId,
                    )}
                    className="service-cover"
                    alt={`Обложка услуги «${service.name}»`}
                  />
                ) : (
                  <span className="service-cover media-fallback" aria-hidden="true">
                    {service.name.charAt(0)}
                  </span>
                )}
                <div className="service-copy">
                  <h3>{service.name}</h3>
                  {(!useV2 || theme.serviceCards.showDescription) &&
                    service.description && <p>{service.description}</p>}
                  <small>{service.durationMin} минут</small>
                </div>
                <div className="service-action">
                  <strong>{money(service.priceMinor)}</strong>
                  {!preview && (
                    <Link
                      className="button secondary compact"
                      to={`/s/${s.publicCode}/book?service=${service.id}`}
                    >
                      Выбрать
                    </Link>
                  )}
                </div>
              </article>
            ))}
        </div>
      </section>
    ) : null,
    staff: catalog ? (
      <section className="storefront-section" key="staff">
        <div className="section-head">
          <h2>Наши мастера</h2>
        </div>
        <div className={`staff-grid staff-grid-${useV2 ? theme.staffCards.variant : "compact"}`}>
          {catalog.staff.map((staffMember, index) => (
            <article className="staff-card" key={staffMember.id}>
              <div className={`staff-avatar tone-${index % 3}`}>
                {staffMember.photoMediaId ? (
                  <Asset
                    tenantId={s.id}
                    media={s.media?.find(
                      (media) => media.id === staffMember.photoMediaId,
                    )}
                    alt={`Фото ${staffMember.name}`}
                  />
                ) : (
                  staffMember.name.charAt(0)
                )}
              </div>
              <div className="staff-card-copy">
                <h3>{staffMember.name}</h3>
                {(!useV2 || theme.staffCards.showRating) &&
                  staffMember.ratingAverage != null &&
                  staffMember.ratingCount != null && (
                    <div
                      className="staff-rating"
                      aria-label={`Рейтинг ${staffMember.ratingAverage} из 5, ${staffMember.ratingCount} оценок`}
                    >
                      ★ {staffMember.ratingAverage.toLocaleString("ru-RU")} ·{" "}
                      {plural(
                        staffMember.ratingCount,
                        "оценка",
                        "оценки",
                        "оценок",
                      )}
                    </div>
                  )}
                {(!useV2 || theme.staffCards.showDescription) &&
                  staffMember.description && <p>{staffMember.description}</p>}
              </div>
            </article>
          ))}
        </div>
      </section>
    ) : null,
    gallery:
      useV2 && theme.galleryMediaIds.length ? (
        <section className="storefront-section" key="gallery">
          <div className="section-head">
            <h2>Галерея</h2>
            <span className="muted">{theme.galleryMediaIds.length} фото</span>
          </div>
          <div className="storefront-gallery">
            {theme.galleryMediaIds.map((id, index) => (
              <button
                type="button"
                key={id}
                aria-label={`Открыть фото салона ${index + 1}`}
                onClick={() => !preview && setGalleryOpen(index)}
              >
                <Asset
                  tenantId={s.id}
                  media={s.media?.find((media) => media.id === id)}
                  privateAsset={preview}
                  alt={`Фото салона ${index + 1}`}
                />
              </button>
            ))}
          </div>
        </section>
      ) : null,
  };
  return (
    <div
      className={`storefront accent-${accent} ${useV2 ? `storefront-v2 theme-${theme.themePreset} mode-${theme.colorMode}` : "storefront-legacy"}`}
      style={useV2 ? storefrontTokenStyle(theme.colorMode, theme.accent) : undefined}
    >
      <div className="storefront-cover">
        <Asset
          tenantId={s.id}
          media={s.media?.find((m) => m.id === theme?.coverMediaId)}
          privateAsset={preview}
          className="cover-image"
          alt="Обложка салона"
          style={{
            objectPosition: `${theme.coverFocalPoint.x}% ${theme.coverFocalPoint.y}%`,
          }}
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
        {!preview ? (
          <Link className="button primary" to={`/s/${s.publicCode}/book`}>
            Записаться <Icon name="arrow" size={16} />
          </Link>
        ) : (
          <span className="button primary preview-cta" aria-hidden="true">
            Записаться <Icon name="arrow" size={16} />
          </span>
        )}
      </div>
      <p className="salon-description">{theme?.description}</p>
      <div className="contact-line">
        <span>✦ {s.contact}</span>
        <span>Часовой пояс: {timezoneLabel(s.timezone)}</span>
      </div>
      {catalog &&
        (useV2 ? theme.sectionOrder : ["services", "staff"]).map(
          (name) => section[name as keyof typeof section],
        )}
      {galleryOpen !== null && theme.galleryMediaIds[galleryOpen] && (
        <Modal title={`Фото ${galleryOpen + 1} из ${theme.galleryMediaIds.length}`} onClose={() => setGalleryOpen(null)}>
          <div className="storefront-lightbox">
            <Asset
              tenantId={s.id}
              media={s.media?.find(
                (media) => media.id === theme.galleryMediaIds[galleryOpen],
              )}
              alt={`Фото салона ${galleryOpen + 1}`}
            />
            <div className="inline-actions">
              <button
                className="button secondary"
                disabled={galleryOpen === 0}
                onClick={() => setGalleryOpen((current) => Math.max(0, (current ?? 0) - 1))}
              >
                Назад
              </button>
              <button
                className="button secondary"
                disabled={galleryOpen === theme.galleryMediaIds.length - 1}
                onClick={() =>
                  setGalleryOpen((current) =>
                    Math.min(theme.galleryMediaIds.length - 1, (current ?? 0) + 1),
                  )
                }
              >
                Далее
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
export function SalonPage() {
  const { code } = useParams();
  const data = useApi<Salon>(`/public/salons/${code}`),
    catalog = useApi<Catalog>(`/public/salons/${code}/catalog`),
    mine = useApi<Items<Salon>>("/me/salons");
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
        {data.data && (
          <StorefrontView salon={data.data} catalog={catalog.data} />
        )}
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
        description="Персональные купоны от партнёров ваших салонов."
      />
      <div className="notice">
        Купон выдаётся после завершённого визита, если вы заранее разрешили
        участие в программе и предложения исходного салона.
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
                <div className="offer-amount">−{money(v.discountMinor)}</div>
                <h3>{v.targetName}</h3>
                <p>{v.termsSnapshot.termsText}</p>
                <small>Действует до {dateTime(v.expiresAt)}</small>
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
            text="Включите участие в профиле и посетите салон с согласованной партнёрской программой."
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
              label="Разрешить выдачу партнёрских купонов после визита"
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
            После визита можно получить персональный купон другого салона.
            Контакты и CRM-заметки партнёрам не передаются.
          </p>
          <Check
            label="Участвовать в партнёрской программе"
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
            Дополнительно разрешите предложения нужного салона ниже. Уже
            выданные купоны сохраняются при отказе.
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
