import type { LoyaltyReward } from "./loyalty";
import { useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api, ApiError, useApi, refreshData, useAuth } from "./api";
import {
  PageTitle,
  Load,
  Field,
  Check,
  Empty,
  Badge,
  money,
  dateTime,
  dayISO,
  useAction,
  Modal,
  SimpleForm,
  BackLink,
  Icon,
} from "./ui";
import type {
  Booking,
  Salon,
  Catalog,
  Items,
  Slot,
  Quote,
  Customer,
  Voucher,
} from "./types";

export function BookingForm({
  work = false,
  reschedule = false,
}: {
  work?: boolean;
  reschedule?: boolean;
}) {
  const { t, code, id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const prefix = work ? `/work/${t}` : "/me";
  const old = useApi<Booking>(reschedule ? `${prefix}/bookings/${id}` : null);
  const options = useApi<Catalog & { salon: Salon }>(
    reschedule
      ? `${prefix}/bookings/${id}/reschedule-options`
      : work
        ? `/work/${t}/booking-options`
        : null,
  );
  const salon = useApi<Salon>(
    !work && !reschedule ? `/public/salons/${code}` : null,
  );
  const publicCatalog = useApi<Catalog>(
    !work && !reschedule ? `/public/salons/${code}/catalog` : null,
  );
  const catalog = options.data ?? publicCatalog.data;
  const selectedSalon = options.data?.salon ?? salon.data;
  const customers = useApi<Items<Customer>>(
    work && !reschedule ? `/work/${t}/customers?limit=100` : null,
  );
  const [rewardId, setRewardId] = useState(params.get("reward") ?? "");
  const [promotionId,setPromotionId]=useState(params.get('promotion')??'');
  const [customerId, setCustomerId] = useState(params.get("customer") ?? ""),
    [serviceId, setServiceId] = useState(params.get("service") ?? ""),
    [staffId, setStaffId] = useState(""),
    [date, setDate] = useState(dayISO(1)),
    [voucherId, setVoucherId] = useState(params.get("voucher") ?? ""),
    [selectedSlot, setSelectedSlot] = useState<Slot>(),
    [quote, setQuote] = useState<Quote>(),
    [challenge, setChallenge] = useState(""),
    [removal, setRemoval] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (old.data) {
      setServiceId(old.data.serviceId);
      setStaffId(old.data.staffId);
      setCustomerId(old.data.customerId);
      setVoucherId(old.data.appliedVoucherId ?? "");
      setRewardId(old.data.loyaltyRewardId ?? "");
      setPromotionId(old.data.promotionVersionId??'');
    }
  }, [old.data?.id]);
  const vouchers = useApi<Items<Voucher>>(
    !work
      ? "/me/vouchers?status=issued"
      : customerId
        ? `/work/${t}/customers/${customerId}/eligible-vouchers`
        : null,
  );
  const rewards = useApi<Items<LoyaltyReward>>(
    !work ? "/me/loyalty-rewards" : null,
  );
  const customerRewards = useApi<{ rewards: LoyaltyReward[] }>(
    work && customerId ? `/work/${t}/customers/${customerId}/loyalty` : null,
  );
  const promotions=useApi<Items<{id:string;title:string;providerTenantId:string;serviceIds:string[];discountType:string;fixedDiscountMinor:number|null;discountPercent:number|null;startsAt:string;endsAt:string}>>('/me/promotions',true);
  const availableRewards =
    (work ? customerRewards.data?.rewards : rewards.data?.items)?.filter(
      (r) =>
        r.status === "issued" && (r.rewardType!=='free_visits'||r.remainingVisits>r.reservedVisits) &&
        r.tenantId === selectedSalon?.id &&
        r.serviceId === serviceId,
    ) ?? [];
  useEffect(() => {
    if (work && !reschedule) setRewardId("");
  }, [customerId]);
  const availableStaff = catalog?.staff.filter((s) =>
    s.serviceIds.includes(serviceId),
  );
  const slotQuery = new URLSearchParams({
    serviceId,
    from: date,
    to: date,
    ...(staffId ? { staffId } : {}),
  }).toString();
  const slotPath = serviceId
    ? reschedule
      ? `${prefix}/bookings/${id}/reschedule-slots?${slotQuery}`
      : work
        ? `/work/${t}/slots?${slotQuery}`
        : `/public/salons/${code}/slots?${slotQuery}`
    : null;
  const slots = useApi<Items<Slot>>(slotPath);
  useEffect(() => {
    setSelectedSlot(undefined);
    setQuote(undefined);
    setChallenge("");
    setRemoval(false);
    setError("");
  }, [serviceId, staffId, date, voucherId, customerId, rewardId,promotionId]);
  async function getQuote(slot: Slot, removeVoucher = false) {
    setBusy(true);
    setError("");
    setSelectedSlot(slot);
    setQuote(undefined);
    setChallenge("");
    try {
      const body = {
        serviceId,
        staffId: slot.staffId,
        startAt: slot.startAt,
        ...(rewardId ? { loyaltyRewardId: rewardId } : {}),
        ...(reschedule||promotionId?{promotionVersionId:promotionId||null}:{}),
        ...(voucherId && !removeVoucher ? { voucherId } : {}),
        ...(work && !reschedule ? { customerId } : {}),
        ...(reschedule
          ? { expectedVersion: old.data!.version, removeVoucher }
          : {}),
      };
      const path = reschedule
        ? `${prefix}/bookings/${id}/reschedule-quotes`
        : work
          ? `/work/${t}/booking-quotes`
          : `/salons/${selectedSalon!.id}/booking-quotes`;
      setQuote(await api<Quote>(path, "POST", body));
      setRemoval(removeVoucher);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка расчёта");
      setRemoval(
        e instanceof ApiError &&
          e.code === "VOUCHER_REMOVAL_CONFIRMATION_REQUIRED",
      );
    } finally {
      setBusy(false);
    }
  }
  async function confirm(acceptOverlap = false) {
    if (!quote) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        quoteId: quote.id,
        confirmedTermsVersion: "booking-p0-v1",
        ...(reschedule
          ? { expectedVersion: old.data!.version, removeVoucher: removal }
          : {}),
        ...(acceptOverlap
          ? { confirmOverlap: true, overlapChallengeToken: challenge }
          : {}),
      };
      const path = reschedule
        ? `${prefix}/bookings/${id}/reschedule`
        : work
          ? `/work/${t}/bookings`
          : `/salons/${selectedSalon!.id}/bookings`;
      const result = await api<Booking>(path, "POST", body);
      refreshData();
      navigate(
        work ? `/work/${t}/bookings/${result.id}` : `/me/bookings/${result.id}`,
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось подтвердить запись",
      );
      if (
        e instanceof ApiError &&
        e.code === "CLIENT_OVERLAP_CONFIRMATION_REQUIRED"
      )
        setChallenge(String(e.details.overlapChallengeToken));
      else setChallenge("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <BackLink
        to={
          reschedule
            ? `${work ? `/work/${t}` : "/me"}/bookings/${id}`
            : work
              ? `/work/${t}/calendar`
              : `/s/${code}`
        }
      />
      <PageTitle
        eyebrow={selectedSalon?.name}
        title={
          reschedule
            ? "Перенести запись"
            : work
              ? "Записать клиента"
              : "Запланируем ваш визит"
        }
        description="Выберите услугу и свободное время. Цена подтверждается сервером перед записью."
      />
      <div className="booking-layout">
        <section className="panel">
          <div className="step-title">
            <span>1</span>
            <h2>Услуга и мастер</h2>
          </div>
          {work && !reschedule && (
            <Field label="Клиент">
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
              >
                <option value="">Выберите клиента</option>
                {customers.data?.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                    {c.userId ? "" : " · ручная карточка"}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Load
            loading={!(catalog && selectedSalon)}
            error={options.error || salon.error || publicCatalog.error}
          >
            <Field label="Услуга">
              <select
                value={serviceId}
                onChange={(e) => {
                  setServiceId(e.target.value);
                  setStaffId("");
                  if (!old.data?.loyaltyRewardId) setRewardId("");
                }}
              >
                <option value="">Выберите услугу</option>
                {catalog?.services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.durationMin} мин · {money(s.priceMinor)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Мастер">
              <select
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
                disabled={!serviceId}
              >
                <option value="">Любой доступный</option>
                {availableStaff?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Награда программы (необязательно)">
              <select
                value={rewardId}
                disabled={!!old.data?.loyaltyRewardId}
                onChange={(e) => {
                  setRewardId(e.target.value);
                  if (e.target.value){setVoucherId("");setPromotionId('');}
                }}
              >
                <option value="">Обычная запись</option>
                {old.data?.loyaltyRewardId && (
                  <option value={old.data.loyaltyRewardId}>
                    Сохранить бесплатное посещение
                  </option>
                )}
                {availableRewards.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.serviceName} · {r.rewardType==='fixed'?`−${money(r.fixedDiscountMinor)}`:r.rewardType==='percent'?`−${r.discountPercent}%`:`${r.remainingVisits} бесплатн. посещ.`}
                  </option>
                ))}
              </select>
            </Field>
            {(rewards.error || customerRewards.error) && (
              <p role="alert">{rewards.error || customerRewards.error}</p>
            )}
            <Field label="Купон (необязательно)">
              <select
                disabled={!!rewardId||!!promotionId}
                value={voucherId}
                onChange={(e) => {setVoucherId(e.target.value);if(e.target.value){setRewardId('');setPromotionId('');}}}
              >
                <option value="">Без купона</option>
                {old.data?.appliedVoucherId && (
                  <option value={old.data.appliedVoucherId}>
                    Сохранить купон текущего визита
                  </option>
                )}
                {vouchers.data?.items
                  .filter(
                    (v) =>
                      (v.rewardType!=='free_visits'||(v.remainingVisits??0)>v.reservedVisits) &&
                      (!v.targetTenantId || v.targetTenantId === selectedSalon?.id),
                  )
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.rewardType==='percent'?`−${v.discountPercent}%`:v.rewardType==='free_visits'?`${v.remainingVisits} бесплатн. посещ.`:`−${money(v.discountMinor)}`} · {v.expiresAt?`до ${dateTime(v.expiresAt)}`:'без срока'}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Временная акция (необязательно)"><select value={promotionId} disabled={!!rewardId||!!voucherId} onChange={e=>{setPromotionId(e.target.value);if(e.target.value){setRewardId('');setVoucherId('');}}}><option value="">Без акции</option>{promotions.data?.items.filter(v=>v.providerTenantId===selectedSalon?.id&&v.serviceIds.includes(serviceId)).map(v=><option key={v.id} value={v.id}>{v.title} · {v.discountType==='percent'?`−${v.discountPercent}%`:`−${money(v.fixedDiscountMinor)}`}</option>)}</select></Field>
          </Load>
          <div className="step-title">
            <span>2</span>
            <h2>Дата и время</h2>
          </div>
          <Field
            label={`Дата · ${selectedSalon?.timezone ?? "часовой пояс салона"}`}
          >
            <input
              type="date"
              value={date}
              min={dayISO()}
              max={dayISO(30)}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          {serviceId ? (
            <Load {...slots}>
              {slots.data?.items.length ? (
                <div className="slots-grid">
                  {slots.data.items.map((s) => (
                    <button
                      key={`${s.startAt}:${s.staffId}`}
                      disabled={busy || (work && !reschedule && !customerId)}
                      className={
                        selectedSlot?.startAt === s.startAt &&
                        selectedSlot?.staffId === s.staffId
                          ? "selected"
                          : ""
                      }
                      onClick={() => void getQuote(s)}
                    >
                      <strong>
                        {new Date(s.startAt).toLocaleTimeString("ru-RU", {
                          hour: "2-digit",
                          minute: "2-digit",
                          timeZone: selectedSalon?.timezone ?? "Europe/Moscow",
                        })}
                      </strong>
                      {!staffId && <small>{s.staffName}</small>}
                    </button>
                  ))}
                </div>
              ) : availableStaff && !availableStaff.length ? (
                // No master provides this service, so no date will ever have slots.
                <Empty
                  title="Услугу пока некому оказывать"
                  text="Салон ещё не назначил мастера на эту услугу. Выберите другую услугу или свяжитесь с салоном."
                />
              ) : (
                <Empty
                  title="Нет свободных интервалов"
                  text="Попробуйте другой день или другого мастера."
                />
              )}
              {!work && selectedSalon && serviceId && (
                <div className="hint-row">
                  <Icon name="bell" />
                  <span>Не нашли удобное время?</span>
                  <Link to={`/me/waitlist/new?code=${encodeURIComponent(selectedSalon.publicCode)}&service=${serviceId}${staffId ? `&staff=${staffId}` : ""}`}>
                    Сообщить, если освободится
                  </Link>
                </div>
              )}
            </Load>
          ) : (
            <p className="muted">Сначала выберите услугу.</p>
          )}
        </section>
        <aside className="panel booking-summary">
          <div className="step-title">
            <span>3</span>
            <h2>Всё верно?</h2>
          </div>
          {quote ? (
            <>
              <span className="eyebrow">{quote.tenantName}</span>
              <h3>{quote.serviceName}</h3>
              <p>{quote.address}</p>
              <dl>
                <dt>Мастер</dt>
                <dd>{quote.staffName}</dd>
                <dt>Дата и время</dt>
                <dd>{dateTime(quote.startAt, selectedSalon?.timezone)}</dd>
                <dt>Продолжительность</dt>
                <dd>{quote.durationMin} минут</dd>
                <dt>Стоимость</dt>
                <dd>{money(quote.priceMinor)}</dd>
                {quote.discountMinor > 0 && (
                  <>
                    <dt>
                      {quote.loyaltyRewardId
                        ? "Бесплатное посещение"
                        : "Скидка"}
                    </dt>
                    <dd>−{money(quote.discountMinor)}</dd>
                  </>
                )}
              </dl>
              <div className="summary-total">
                <span>К оплате в салоне</span>
                <strong>{money(quote.totalMinor)}</strong>
              </div>
              <p className="small muted">
                Перенос и самостоятельная отмена доступны до начала визита.
                Расчёт действует 5 минут. Выбор слота не удерживает его до
                подтверждения.
              </p>
              {removal && (
                <div className="notice">
                  При подтверждении переноса купон будет снят. Новая цена:{" "}
                  {money(quote.totalMinor)}.
                </div>
              )}
            </>
          ) : (
            <Empty
              title="Выберите время"
              text="Здесь появятся мастер, условия и итоговая стоимость."
            />
          )}
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {removal && !quote && selectedSlot && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void getQuote(selectedSlot, true)}
            >
              Показать новую цену без купона
            </button>
          )}
          {quote &&
            (challenge ? (
              <div className="stack">
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void confirm(true)}
                >
                  {work
                    ? "Согласовано с клиентом — продолжить"
                    : "Всё равно записаться"}
                </button>
                <button
                  className="button secondary"
                  onClick={() => {
                    setQuote(undefined);
                    setChallenge("");
                    setError("");
                  }}
                >
                  Выбрать другое время
                </button>
              </div>
            ) : (
              <button
                className="button primary full"
                disabled={busy}
                onClick={() => void confirm()}
              >
                {busy
                  ? "Подтверждаем…"
                  : reschedule
                    ? "Подтвердить перенос"
                    : "Подтвердить запись"}
              </button>
            ))}
          <p className="small muted">
            Сообщения и партнёрские предложения включаются отдельно в{" "}
            <Link to="/me/profile">профиле</Link>.
          </p>
        </aside>
      </div>
    </>
  );
}

const ratingLabels = [
  "",
  "Очень плохо",
  "Плохо",
  "Нормально",
  "Хорошо",
  "Отлично",
];

function VisitReviewPanel({
  booking,
  reload,
}: {
  booking: Booking;
  reload: () => void;
}) {
  const review = booking.review;
  const [rating, setRating] = useState(review?.rating ?? 0);
  const [editing, setEditing] = useState(
    !review || review.status !== "active",
  );
  const action = useAction();
  useEffect(() => {
    setRating(review?.rating ?? 0);
    setEditing(!review || review.status !== "active");
  }, [review?.id, review?.rating, review?.status, review?.version]);

  if (booking.status !== "completed") {
    if (review?.status !== "invalidated") return null;
    return (
      <div className="review-box">
        <h3>Оценка мастера</h3>
        <p className="muted">
          Оценка больше не учитывается: статус визита изменён.
        </p>
      </div>
    );
  }

  if (review?.status === "active" && !editing)
    return (
      <div className="review-box">
        <span className="eyebrow">ВАША ОЦЕНКА МАСТЕРА</span>
        <div
          className="review-summary"
          aria-label={`Оценка ${review.rating} из 5`}
        >
          <strong>
            {"★".repeat(review.rating)}
            {"☆".repeat(5 - review.rating)}
          </strong>
          <span>{ratingLabels[review.rating]}</span>
        </div>
        <button className="text-button" onClick={() => setEditing(true)}>
          Изменить оценку
        </button>
      </div>
    );

  return (
    <div className="review-box">
      <span className="eyebrow">
        {review?.status === "invalidated"
          ? "ОЦЕНИТЕ СНОВА"
          : "КАК ПРОШЁЛ ВИЗИТ?"}
      </span>
      <h3>Оцените работу мастера {booking.staffName}</h3>
      {review?.status === "invalidated" && (
        <p className="small muted">
          Предыдущая оценка была отозвана после изменения исхода визита.
        </p>
      )}
      <div
        className="star-picker"
        role="radiogroup"
        aria-label="Оценка мастера"
      >
        {[1, 2, 3, 4, 5].map((value) => (
          <label key={value}>
            <input
              type="radio"
              name={`review-${booking.id}`}
              value={value}
              checked={rating === value}
              onChange={() => setRating(value)}
              aria-label={`${value} из 5 — ${ratingLabels[value]}`}
            />
            <span aria-hidden="true">★</span>
          </label>
        ))}
      </div>
      {rating > 0 && <p className="rating-label">{ratingLabels[rating]}</p>}
      <div className="inline-actions">
        <button
          className="button primary"
          disabled={!rating || action.busy}
          onClick={() =>
            void action.run(async () => {
              await api(
                `/me/bookings/${booking.id}/review`,
                review?.status === "active" ? "PATCH" : "POST",
                {
                  rating,
                  ...(review?.status === "active"
                    ? { expectedVersion: review.version }
                    : {}),
                },
              );
              setEditing(false);
              reload();
            }, `Спасибо! Вы оценили работу мастера на ${rating} из 5`)
          }
        >
          {action.busy ? "Сохраняем…" : "Сохранить оценку"}
        </button>
        {review?.status === "active" && (
          <button
            className="button secondary"
            disabled={action.busy}
            onClick={() => {
              setRating(review.rating);
              setEditing(false);
            }}
          >
            Отмена
          </button>
        )}
      </div>
      {action.feedback}
    </div>
  );
}

export function BookingPage({ work = false }: { work?: boolean }) {
  const { t, id } = useParams();
  const path = work ? `/work/${t}/bookings/${id}` : `/me/bookings/${id}`;
  const data = useApi<Booking>(path, true);
  const [modal, setModal] = useState("");
  const action = useAction();
  const auth = useAuth();
  return (
    <>
      <BackLink
        to={work ? `/work/${t}/calendar` : "/me/bookings"}
        label="В календарь"
      />
      <PageTitle title="Карточка визита" description={data.data?.tenantName} />
      <Load {...data}>
        {data.data &&
          (() => {
            const b = data.data;
            return (
              <div className="two-columns">
                <section className="panel">
                  <div className="section-head">
                    <span className="eyebrow">
                      {work ? b.customerName : "ВАША ЗАПИСЬ"}
                    </span>
                    <Badge status={b.status} />
                  </div>
                  <h2>{b.serviceNameSnapshot}</h2>
                  {b.loyaltyRewardId && (
                    <p className="notice success">
                      Бесплатное посещение по программе лояльности
                    </p>
                  )}
                  <dl>
                    <dt>Начало</dt>
                    <dd>{dateTime(b.startAt, b.timezoneSnapshot)}</dd>
                    <dt>Окончание</dt>
                    <dd>{dateTime(b.endAt, b.timezoneSnapshot)}</dd>
                    <dt>Мастер</dt>
                    <dd>{b.staffName}</dd>
                    {b.totalMinor !== undefined && (
                      <>
                        <dt>Стоимость</dt>
                        <dd>{money(b.priceMinorSnapshot)}</dd>
                        <dt>Скидка</dt>
                        <dd>{money(b.discountMinor ?? 0)}</dd>
                        <dt>К оплате в салоне</dt>
                        <dd>
                          <strong>{money(b.totalMinor)}</strong>
                        </dd>
                      </>
                    )}
                  </dl>
                  {b.timezoneSnapshot !== "Europe/Moscow" && (
                    <p className="small muted">
                      Время указано в часовом поясе салона (
                      {b.timezoneSnapshot}).
                    </p>
                  )}
                  {!work && (
                    <VisitReviewPanel booking={b} reload={data.reload} />
                  )}
                  <div className="inline-actions">
                    {b.allowedActions.includes("reschedule") && (
                      <Link
                        className="button primary"
                        to={`${work ? `/work/${t}` : "/me"}/bookings/${id}/reschedule`}
                      >
                        Перенести
                      </Link>
                    )}
                    {!work && b.allowedActions.includes("reschedule") && b.publicCode && (
                      <Link className="button secondary" to={`/me/waitlist/new?code=${encodeURIComponent(b.publicCode)}&service=${b.serviceId}&staff=${b.staffId}&linked=${b.id}`}>
                        Хочу раньше
                      </Link>
                    )}
                    {b.allowedActions.includes("cancel") && (
                      <button
                        className="button secondary"
                        onClick={() => setModal("cancel")}
                      >
                        Отменить
                      </button>
                    )}
                    {b.allowedActions.includes("complete") && (
                      <button
                        className="button primary"
                        disabled={action.busy}
                        onClick={() => setModal("complete")}
                      >
                        Завершить визит
                      </button>
                    )}
                    {b.allowedActions.includes("no-show") && (
                      <button
                        className="button secondary"
                        disabled={action.busy}
                        onClick={() => setModal("no-show")}
                      >
                        Неявка
                      </button>
                    )}
                    {b.allowedActions.includes("correct-outcome") && (
                      <button
                        className="button secondary"
                        onClick={() => setModal("correct-outcome")}
                      >
                        Исправить исход
                      </button>
                    )}
                    {!work && b.publicCode && (
                      <Link
                        className="button secondary"
                        to={`/s/${b.publicCode}/book`}
                      >
                        Записаться снова
                      </Link>
                    )}
                  </div>
                  {action.feedback}
                  {work &&
                    b.customerId &&
                    auth.me?.memberships.find((m) => m.tenantId === t)?.role !==
                      "master" && (
                      <Link
                        className="back-link"
                        to={`/work/${t}/customers/${b.customerId}`}
                      >
                        Открыть карточку клиента →
                      </Link>
                    )}
                </section>
                <section className="panel">
                  <h2>История и уведомления</h2>
                  {b.history?.length ? (
                    b.history.map((h) => (
                      <div className="timeline-row" key={h.version}>
                        <span className="timeline-dot" />
                        <div>
                          <strong>Версия {h.version}</strong>
                          <p>{h.reason ?? "Состояние записи сохранено"}</p>
                          <small>{dateTime(h.createdAt)}</small>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="muted">
                      Доступная история изменений появится здесь.
                    </p>
                  )}
                  {b.deliveries?.map((d, i) => (
                    <div className="delivery-row" key={i}>
                      <span>
                        {d.category === "reminder"
                          ? "Напоминание"
                          : "Сообщение бота"}
                      </span>
                      <Badge status={d.state} />
                    </div>
                  ))}
                  <p className="small muted">
                    «Принято MAX» означает приём сообщения платформой, а не
                    прочтение клиентом. Запись действует независимо от доставки.
                  </p>
                </section>
                {modal && (
                  <Modal
                    title={
                      modal === "cancel"
                        ? "Отменить запись"
                        : modal === "no-show"
                          ? "Отметить неявку"
                          : modal === "complete"
                            ? "Завершить визит"
                            : "Исправить исход"
                    }
                    onClose={() => setModal("")}
                  >
                    {modal === "complete" ? (
                      <>
                        <p>
                          Визит будет отмечен как завершённый. Это начислит
                          отметку лояльности и, если условия выполнены, выдаст
                          награду или партнёрский купон.
                        </p>
                        <p className="small muted">
                          Исправить исход позже не получится, если выданная
                          награда уже зарезервирована или использована.
                        </p>
                        <button
                          className="button primary"
                          disabled={action.busy}
                          onClick={() =>
                            void action.run(async () => {
                              await api(`${path}/complete`, "POST", {
                                expectedVersion: b.version,
                              });
                              setModal("");
                            }, "Визит завершён")
                          }
                        >
                          Подтвердить завершение
                        </button>
                        {action.feedback}
                      </>
                    ) : modal === "no-show" ? (
                      <>
                        <p>
                          Визит будет отмечен как неявка. Зарезервированный
                          купон освободится по правилам срока.
                        </p>
                        <button
                          className="button primary"
                          disabled={action.busy}
                          onClick={() =>
                            void action.run(async () => {
                              await api(`${path}/no-show`, "POST", {
                                expectedVersion: b.version,
                              });
                              setModal("");
                            })
                          }
                        >
                          Подтвердить неявку
                        </button>
                        {action.feedback}
                      </>
                    ) : (
                      <SimpleForm
                        fields={[
                          {
                            name: "reason",
                            label: "Причина",
                            type: "textarea",
                            required: work || modal === "correct-outcome",
                          },
                        ]}
                        submit="Подтвердить"
                        onSubmit={async (v) => {
                          if (modal === "cancel")
                            await api(`${path}/cancel`, "POST", {
                              expectedVersion: b.version,
                              ...(v.reason ? { reason: v.reason } : {}),
                            });
                          else
                            await api(`${path}/correct-outcome`, "POST", {
                              expectedVersion: b.version,
                              reason: v.reason,
                              targetStatus: v.targetStatus,
                              restorePreviousVoucher:
                                v.restorePreviousVoucher === "on",
                            });
                          setModal("");
                        }}
                      >
                        {modal === "correct-outcome" && (
                          <>
                            <Field label="Правильный исход">
                              <select name="targetStatus">
                                {["completed", "no_show", "cancelled"]
                                  .filter((s) => s !== b.status)
                                  .map((s) => (
                                    <option key={s} value={s}>
                                      {s === "completed"
                                        ? "Завершён"
                                        : s === "no_show"
                                          ? "Неявка"
                                          : "Отменён"}
                                    </option>
                                  ))}
                              </select>
                            </Field>
                            <label className="check">
                              <input
                                type="checkbox"
                                name="restorePreviousVoucher"
                              />
                              <span>
                                Явно восстановить прежнюю скидку, если купон всё
                                ещё доступен
                              </span>
                            </label>
                            <p className="small muted">
                              Исправление не выпускает новые купоны.
                              Использованные купоны не восстанавливаются;
                              зависимые обязательства требуют разбора.
                            </p>
                          </>
                        )}
                      </SimpleForm>
                    )}
                  </Modal>
                )}
              </div>
            );
          })()}
      </Load>
    </>
  );
}
