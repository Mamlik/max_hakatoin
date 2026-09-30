import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
  useLocation,
} from "react-router-dom";
import { api, useApi, useAuth, refreshData, currentSession } from "./api";
import { PromotionCards } from './promotions-ui';
import { normalizeStyle } from "./storefront-style";
import { storefrontTokenStyle } from "./storefront-tokens";
import { ThemeModePicker, useColorMode } from "./theme";
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
import { DiscoveryMap } from "./discovery-map";
import type { MapBounds } from "./map-adapter";
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
  DiscoveryResponse,
  DiscoverySalon,
  SalonSocialLink,
} from "./types";
export { BookingForm, BookingPage } from "./booking-ui";
// Kept only in page memory after the user explicitly requests nearby search.
// Coordinates never enter a URL, local storage, or navigation state.
let ephemeralDiscoveryPoint: { latitude: number; longitude: number } | null = null;
const EMPTY_DISCOVERY_RESULTS: DiscoverySalon[] = [];

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
  const [state, setState] = useState("upcoming"),
    [tenant, setTenant] = useState(""),
    [day, setDay] = useState("");
  const data = useApi<Items<Booking>>(
    `/me/bookings?limit=100&state=${state}${tenant ? `&tenantId=${tenant}` : ""}${day ? `&day=${day}` : ""}`,
    true,
  );
  const salons = useApi<Items<Salon>>("/me/salons");
  return (
    <>
      <PageTitle
        eyebrow="ВАШЕ ВРЕМЯ"
        title="Мои записи"
        description="Ближайшие визиты и история во всех салонах."
        action={
          <Link className="button primary" to="/me/salons">
            <Icon name="plus" />
            Новая запись
          </Link>
        }
      />
      <div className="booking-toolbar">
        <div className="tabs" role="tablist" aria-label="Период записей">
          <button
            type="button"
            role="tab"
            aria-selected={state === "upcoming"}
            className={state === "upcoming" ? "selected" : ""}
            onClick={() => setState("upcoming")}
          >
            Ближайшие
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={state === "history"}
            className={state === "history" ? "selected" : ""}
            onClick={() => setState("history")}
          >
            История
          </button>
        </div>
        <div className="booking-filters">
          <select aria-label="Фильтр по салону" value={tenant} onChange={(e) => setTenant(e.target.value)}>
            <option value="">Все салоны</option>
            {salons.data?.items.map((salon) => <option key={salon.id} value={salon.id}>{salon.name}</option>)}
          </select>
          <input aria-label="Выбрать дату" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          {day && <button type="button" className="text-button" onClick={() => setDay("")}>Сбросить дату</button>}
        </div>
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
          <small className="salon-card-category">{s.category}</small>
        </div>
        <span className="circle-arrow">
          <Icon name="arrow" size={16} />
        </span>
      </div>
    </Link>
  );
}
export function DiscoverPage() {
  const mine = useApi<Items<Salon>>("/me/salons");
  const auth = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const [queryInput, setQueryInput] = useState(searchParams.get("q") ?? "");
  const [minPriceInput, setMinPriceInput] = useState(searchParams.get("minPriceMinor") ? String(Number(searchParams.get("minPriceMinor")) / 100) : "");
  const [maxPriceInput, setMaxPriceInput] = useState(searchParams.get("maxPriceMinor") ? String(Number(searchParams.get("maxPriceMinor")) / 100) : "");
  const [nearby, setNearby] = useState<{ latitude: number; longitude: number } | null>(() => ephemeralDiscoveryPoint);
  const [geoError, setGeoError] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [pendingBounds, setPendingBounds] = useState<MapBounds | null>(null);
  const [pendingZoom, setPendingZoom] = useState(11);
  const [selected, setSelected] = useState<DiscoverySalon | null>(null);
  const [extraItems, setExtraItems] = useState<DiscoverySalon[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [moreError, setMoreError] = useState("");
  const [moreLoading, setMoreLoading] = useState(false);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const configData = useApi<{ salonDiscovery?: { mapEnabled?: boolean; mapStyleLight?: string; mapStyleDark?: string } }>("/config");
  const facets = useApi<{
    categories: { name: string; count: number }[];
    cities: { name: string; count: number }[];
    districts: { name: string; count: number }[];
    metroStations: { name: string; count: number }[];
    services: { id: string; name: string; salonCount: number }[];
  }>("/public/salons/discover/facets");
  const mode = searchParams.get("mode") === "map" ? "map" : "list";
  const apiParams = new URLSearchParams(searchParams);
  apiParams.set("mode", mode);
  apiParams.delete("selected");
  apiParams.delete("cursor");
  if (nearby) {
    apiParams.set("lat", String(nearby.latitude));
    apiParams.set("lng", String(nearby.longitude));
  } else {
    apiParams.delete("lat");
    apiParams.delete("lng");
    apiParams.delete("radiusKm");
    if (apiParams.get("sort") === "nearby") apiParams.delete("sort");
  }
  const path = `/public/salons/discover?${apiParams.toString()}`;
  const publicData = useApi<DiscoveryResponse>(path);
  useEffect(() => {
    setExtraItems([]);
    setMoreError("");
    setNextCursor(null);
  }, [path]);
  const urlQuery = searchParams.get("q") ?? "";
  useEffect(() => setQueryInput(urlQuery), [urlQuery]);
  useEffect(() => {
    setMinPriceInput(searchParams.get("minPriceMinor") ? String(Number(searchParams.get("minPriceMinor")) / 100) : "");
    setMaxPriceInput(searchParams.get("maxPriceMinor") ? String(Number(searchParams.get("maxPriceMinor")) / 100) : "");
  }, [searchParams.get("minPriceMinor"), searchParams.get("maxPriceMinor")]);
  useEffect(() => {
    if (!nearby && (searchParams.has("radiusKm") || searchParams.get("sort") === "nearby")) {
      const next = new URLSearchParams(searchParams);
      next.delete("radiusKm");
      if (next.get("sort") === "nearby") next.delete("sort");
      setSearchParams(next, { replace: true });
    }
  }, [nearby]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const current = searchParams.get("q") ?? "";
      if (current === queryInput.trim()) return;
      const next = new URLSearchParams(searchParams);
      if (queryInput.trim()) next.set("q", queryInput.trim()); else next.delete("q");
      next.delete("selected");
      next.delete("cursor");
      setSearchParams(next, { replace: true });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [queryInput, searchParams, setSearchParams]);
  const updateParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== "mode" && key !== "selected") next.delete("selected");
    next.delete("cursor");
    if (key !== "mode" && key !== "selected") setSelected(null);
    setSearchParams(next);
  };
  const requestLocation = () => {
    setGeoError("");
    if (!navigator.geolocation) { setGeoError("Это устройство не передаёт геопозицию браузеру."); return; }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const point = { latitude: coords.latitude, longitude: coords.longitude };
        ephemeralDiscoveryPoint = point;
        setNearby(point);
        const next = new URLSearchParams(searchParams);
        next.delete("selected");
        next.set("radiusKm", next.get("radiusKm") || "5");
        next.set("sort", "nearby");
        setSearchParams(next);
        setSelected(null);
      },
      () => setGeoError("Не удалось получить геопозицию. Разрешите доступ или выберите город вручную."),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
    );
  };
  const clearLocation = () => {
    ephemeralDiscoveryPoint = null;
    setNearby(null);
    const next = new URLSearchParams(searchParams);
    next.delete("radiusKm"); next.delete("sort"); next.delete("viewport");
    next.delete("selected");
    setSearchParams(next);
    setSelected(null);
  };
  const commitPrice = (key: "minPriceMinor" | "maxPriceMinor", value: string) => {
    const amount = value.trim() ? Number(value) : NaN;
    if (value.trim() && (!Number.isFinite(amount) || amount < 0 || amount > 1000000)) return;
    updateParam(key, value.trim() ? String(Math.round(amount * 100)) : "");
  };
  const clearFilters = () => {
    const next = new URLSearchParams();
    next.set("mode", mode);
    setSearchParams(next);
    setQueryInput("");
    ephemeralDiscoveryPoint = null;
    setNearby(null);
  };
  const clearPriceFilters = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("minPriceMinor");
    next.delete("maxPriceMinor");
    next.delete("cursor");
    next.delete("selected");
    setSelected(null);
    setSearchParams(next);
  };
  const discover = publicData.data?.items ?? EMPTY_DISCOVERY_RESULTS;
  const items = useMemo(() => [...discover, ...extraItems], [discover, extraItems]);
  const selectedCode = searchParams.get("selected");
  useEffect(() => {
    if (!selectedCode) { setSelected(null); return; }
    const salon = items.find((item) => item.publicCode === selectedCode);
    if (salon) setSelected(salon);
  }, [selectedCode, publicData.data, extraItems]);
  useEffect(() => {
    if (mode !== "map" || !selected?.id) return;
    cardRefs.current.get(selected.id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [mode, selected?.id]);
  const hasActiveFilters = ["categories", "serviceIds", "city", "district", "metroIds", "minPriceMinor", "maxPriceMinor", "radiusKm", "openNow", "onlineBooking", "favoritesOnly"].some((key) => searchParams.has(key)) || !!nearby;
  const selectedValues = (key: string) => (searchParams.get(key) ?? "").split(",").filter(Boolean);
  const toggleListFilter = (key: string, value: string, checked: boolean) => {
    const next = new URLSearchParams(searchParams);
    const values = new Set((next.get(key) ?? "").split(",").filter(Boolean));
    if (checked) values.add(value); else values.delete(value);
    if (values.size) next.set(key, [...values].join(",")); else next.delete(key);
    next.delete("cursor");
    setSearchParams(next);
  };
  const multiFilter = (key: string, title: string, options: Array<{ value: string; label: string }>) => {
    const selected = selectedValues(key);
    return <details className="discovery-multi-filter">
      <summary>{title}{selected.length ? ` · ${selected.length}` : ""}</summary>
      <div className="discovery-multi-options">
        {options.map((option) => <label key={option.value}>
          <input type="checkbox" checked={selected.includes(option.value)} onChange={(event) => toggleListFilter(key, option.value, event.target.checked)} />
          <span>{option.label}</span>
        </label>)}
        {!options.length && <span className="muted">В этом каталоге пока нет вариантов</span>}
      </div>
    </details>;
  };
  const activeChips: Array<{ key: string; label: string; clear: () => void }> = [];
  if (searchParams.get("q")) activeChips.push({ key: "q", label: `Поиск: ${searchParams.get("q")}`, clear: () => updateParam("q", "") });
  if (selectedValues("categories").length) activeChips.push({ key: "categories", label: `Направления · ${selectedValues("categories").length}`, clear: () => updateParam("categories", "") });
  if (searchParams.get("city")) activeChips.push({ key: "city", label: searchParams.get("city")!, clear: () => updateParam("city", "") });
  if (searchParams.get("district")) activeChips.push({ key: "district", label: searchParams.get("district")!, clear: () => updateParam("district", "") });
  if (selectedValues("metroIds").length) activeChips.push({ key: "metroIds", label: `Метро · ${selectedValues("metroIds").length}`, clear: () => updateParam("metroIds", "") });
  if (selectedValues("serviceIds").length) activeChips.push({ key: "serviceIds", label: `Услуги · ${selectedValues("serviceIds").length}`, clear: () => updateParam("serviceIds", "") });
  if (searchParams.has("minPriceMinor") || searchParams.has("maxPriceMinor")) activeChips.push({ key: "price", label: "Цена", clear: clearPriceFilters });
  if (nearby) activeChips.push({ key: "nearby", label: `Рядом · ${searchParams.get("radiusKm") ?? 5} км`, clear: clearLocation });
  if (searchParams.get("openNow") === "true") activeChips.push({ key: "openNow", label: "Открыто сейчас", clear: () => updateParam("openNow", "") });
  if (searchParams.get("onlineBooking") === "true") activeChips.push({ key: "onlineBooking", label: "Онлайн-запись", clear: () => updateParam("onlineBooking", "") });
  if (searchParams.get("favoritesOnly") === "true") activeChips.push({ key: "favoritesOnly", label: "Избранное", clear: () => updateParam("favoritesOnly", "") });
  if (searchParams.has("viewport")) activeChips.push({ key: "viewport", label: "Область карты", clear: () => { const next = new URLSearchParams(searchParams); next.delete("viewport"); next.delete("zoom"); setSearchParams(next); } });
  const filters = (
    <div className="discovery-filter-grid">
      {multiFilter("categories", "Направления", facets.data?.categories.map((item) => ({ value: item.name, label: `${item.name} · ${item.count}` })) ?? [])}
      <label className="field"><span>Город</span>
        <select value={searchParams.get("city") ?? ""} onChange={(event) => updateParam("city", event.target.value)}>
          <option value="">Все города</option>
          {facets.data?.cities.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
        </select>
      </label>
      <label className="field"><span>Район</span>
        <select value={searchParams.get("district") ?? ""} onChange={(event) => updateParam("district", event.target.value)}>
          <option value="">Любой район</option>
          {facets.data?.districts.map((item) => <option key={item.name} value={item.name}>{item.name} · {item.count}</option>)}
        </select>
      </label>
      {multiFilter("metroIds", "Метро", facets.data?.metroStations.map((item) => ({ value: item.name, label: `${item.name} · ${item.count}` })) ?? [])}
      {multiFilter("serviceIds", "Услуги", facets.data?.services.map((item) => ({ value: item.id, label: item.name })) ?? [])}
      <label className="field"><span>Сортировка</span>
        <select value={searchParams.get("sort") ?? "recommended"} onChange={(event) => updateParam("sort", event.target.value)}>
          <option value="recommended">Сначала подходящие</option>
          {nearby && <option value="nearby">Сначала ближайшие</option>}
          <option value="cheaper">Сначала дешевле</option>
          <option value="expensive">Сначала дороже</option>
          <option value="name">По названию</option>
        </select>
      </label>
      <label className="field"><span>Цена от, ₽</span><input type="number" min="0" max="1000000" inputMode="numeric" value={minPriceInput} onChange={(event) => setMinPriceInput(event.target.value)} onBlur={() => commitPrice("minPriceMinor", minPriceInput)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
      <label className="field"><span>Цена до, ₽</span><input type="number" min="0" max="1000000" inputMode="numeric" value={maxPriceInput} onChange={(event) => setMaxPriceInput(event.target.value)} onBlur={() => commitPrice("maxPriceMinor", maxPriceInput)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
      {nearby && <label className="field"><span>Радиус</span>
        <select value={searchParams.get("radiusKm") ?? "5"} onChange={(event) => updateParam("radiusKm", event.target.value)}>
          {[1, 3, 5, 10, 25].map((value) => <option key={value} value={value}>{value} км</option>)}
        </select>
      </label>}
      <label className="discovery-check"><input type="checkbox" checked={searchParams.get("openNow") === "true"} onChange={(event) => updateParam("openNow", event.target.checked ? "true" : "")} /><span>Открыто сейчас</span></label>
      <label className="discovery-check"><input type="checkbox" checked={searchParams.get("onlineBooking") === "true"} onChange={(event) => updateParam("onlineBooking", event.target.checked ? "true" : "")} /><span>Можно записаться онлайн</span></label>
      {auth.me && <label className="discovery-check"><input type="checkbox" checked={searchParams.get("favoritesOnly") === "true"} onChange={(event) => updateParam("favoritesOnly", event.target.checked ? "true" : "")} /><span>Только избранное</span></label>}
      {nearby && <div className="discovery-nearby-control"><span>Рядом с вами · геопозиция используется только для этого поиска</span><button type="button" className="text-button" onClick={clearLocation}>Сбросить</button></div>}
    </div>
  );
  const salonLocationState = { from: `${location.pathname}${location.search}` };
  const selectSalon = (salon: DiscoverySalon) => {
    navigate(`/s/${salon.publicCode}`, { state: salonLocationState });
  };
  const openSalon = (salon: DiscoverySalon) => <Link className="button primary" to={`/s/${salon.publicCode}`} state={salonLocationState}>О салоне <Icon name="arrow" size={16} /></Link>;
  const card = (salon: DiscoverySalon) => (
    <article ref={(element) => { if (element) cardRefs.current.set(salon.id, element); else cardRefs.current.delete(salon.id); }} className={`discovery-card${selected?.id === salon.id ? " selected" : ""}`} key={salon.id}>
      <Link className="discovery-card-cover" to={`/s/${salon.publicCode}`} state={salonLocationState} aria-label={`Открыть салон «${salon.name}»`}>
        {salon.cover && <Asset tenantId={salon.id} media={salon.cover} alt="" />}
        {!salon.cover && <span aria-hidden="true">{salon.name.slice(0, 1)}</span>}
        <small>{salon.category}</small>
      </Link>
      <div className="discovery-card-body">
        <div className="discovery-card-heading"><h3>{salon.name}</h3>{salon.rating !== null && <span aria-label={`Рейтинг ${salon.rating} из 5`}>★ {salon.rating.toLocaleString("ru-RU")}</span>}</div>
        <p>{salon.shortDescription || salon.address}</p>
        <div className="discovery-card-meta">
          {salon.openNow && <span className="discovery-open">Открыто</span>}
          {salon.onlineBooking && <span>Онлайн-запись</span>}
          {salon.distanceKm !== null && <span>{salon.distanceKm < 1 ? `${Math.round(salon.distanceKm * 1000)} м` : `${salon.distanceKm.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км`}</span>}
          {salon.matchedServices?.length > 0 && <span>{salon.matchedServices.slice(0, 2).join(" · ")}</span>}
        </div>
        <div className="discovery-card-footer">
          <strong>{salon.minPriceMinor === null ? "Цены уточняйте" : `от ${money(salon.minPriceMinor)}`}</strong>
          {mode === "map" && salon.location && <button type="button" className="button secondary discovery-locate-salon" onClick={() => selectSalon(salon)}>На карте</button>}
          {openSalon(salon)}
        </div>
      </div>
    </article>
  );
  const loadMore = async () => {
    const cursor = nextCursor ?? publicData.data?.nextCursor;
    if (!cursor || moreLoading) return;
    setMoreLoading(true); setMoreError("");
    try {
      const next = new URLSearchParams(apiParams);
      next.set("cursor", cursor);
      const result = await api<DiscoveryResponse>(`/public/salons/discover?${next.toString()}`);
      setExtraItems((old) => [...old, ...result.items]);
      setNextCursor(result.nextCursor);
    } catch (cause) { setMoreError(cause instanceof Error ? cause.message : "Не удалось загрузить салоны"); }
    finally { setMoreLoading(false); }
  };
  const mapEnabled = configData.data?.salonDiscovery?.mapEnabled !== false;
  const expandedRadius = [1, 3, 5, 10, 25].find((value) => value > Number(searchParams.get("radiusKm") ?? 5));
  return (
    <>
      <PageTitle
        eyebrow="КАТАЛОГ ГОРОДСКИХ САЛОНОВ"
        title="Найти салон"
        description="Сравните услуги, цены и расположение. Фильтры сохраняются в ссылке."
      />
      <div className="search-box place-search">
        <Icon name="search" />
        <input
          aria-label="Поиск салона"
          placeholder="Салон, услуга или район"
          value={queryInput}
          onChange={(e) => setQueryInput(e.target.value)}
        />
        {!!queryInput && <button type="button" aria-label="Очистить поиск" onClick={() => setQueryInput("")}>×</button>}
      </div>
      {!searchParams.get("q") && mode === "list" && !hasActiveFilters && !!mine.data?.items.length && (
        <section className="familiar-salons">
          <div className="section-head"><h2>Мои места</h2></div>
          <div className="salon-grid">{mine.data.items.map((salon) => <SalonCard key={salon.id} salon={salon} />)}</div>
        </section>
      )}
      <div className="discovery-toolbar">
        <button type="button" className="button secondary" onClick={requestLocation}><Icon name="salons" size={16} />{nearby ? "Геопозиция включена" : "Рядом со мной"}</button>
        <div className="discovery-view-switch" role="group" aria-label="Режим просмотра">
          <button type="button" aria-pressed={mode === "list"} onClick={() => updateParam("mode", "list")}>Список</button>
          <button type="button" aria-pressed={mode === "map"} disabled={!mapEnabled} onClick={() => updateParam("mode", "map")}>Карта</button>
        </div>
        <button type="button" className="button secondary discovery-mobile-filter" onClick={() => setFiltersOpen(true)}>Фильтры{hasActiveFilters ? " · включены" : ""}</button>
      </div>
      {!!activeChips.length && <div className="discovery-active-filters" aria-label="Активные фильтры">
        {activeChips.map((chip) => <button type="button" key={chip.key} onClick={chip.clear} aria-label={`Убрать фильтр: ${chip.label}`}>{chip.label}<span aria-hidden="true"> ×</span></button>)}
        <button type="button" className="discovery-clear-all" onClick={clearFilters}>Сбросить фильтры</button>
      </div>}
      {geoError && <div className="notice" role="status">{geoError}</div>}
      <section className="discovery-filters-desktop" aria-label="Фильтры каталога">{filters}</section>
      {filtersOpen && <Modal title="Фильтры салонов" onClose={() => setFiltersOpen(false)}><div className="discovery-filter-modal">{filters}<button type="button" className="button primary" onClick={() => setFiltersOpen(false)}>Показать салоны</button></div></Modal>}
      {mode === "map" && mapEnabled && (
        <section className="discovery-map-panel" aria-label="Салоны на карте">
          <DiscoveryMap
            items={discover}
            clusters={publicData.data?.clusters}
            selectedId={selected?.id}
            userLocation={nearby}
            styles={{ light: configData.data?.salonDiscovery?.mapStyleLight, dark: configData.data?.salonDiscovery?.mapStyleDark }}
            onSelect={selectSalon}
            onViewport={(bounds, zoom) => { setPendingBounds(bounds); setPendingZoom(zoom); }}
          />
          {pendingBounds && <button type="button" className="button primary discovery-map-search" onClick={() => {
            const next = new URLSearchParams(searchParams);
            next.set("viewport", [pendingBounds.west, pendingBounds.south, pendingBounds.east, pendingBounds.north].map((value) => value.toFixed(5)).join(","));
            next.set("zoom", String(Math.round(pendingZoom)));
            next.delete("selected");
            setSelected(null);
            setSearchParams(next);
          }}>Искать в этой области</button>}
        </section>
      )}
      <div className="section-head">
        <h2>{searchParams.get("q") ? "Результаты поиска" : mode === "map" ? "На карте" : "Салоны поблизости и в городе"}</h2>
        <span className="muted">{publicData.data ? `${publicData.data.totalApprox.toLocaleString("ru-RU")} ${plural(publicData.data.totalApprox, "салон", "салона", "салонов")}` : "Ищем…"}</span>
      </div>
      <Load {...publicData}>
        {items.length ? <div className="discovery-results">{items.map(card)}</div> : (
          <Empty
            title={searchParams.get("q") ? "Ничего не нашлось" : hasActiveFilters ? "Подходящих салонов нет" : mode === "map" ? "На карте пока пусто" : "Пока нет опубликованных салонов"}
            text={mode === "map" && !searchParams.get("q")
              ? "Здесь отображаются салоны с опубликованной точкой на карте. Переключитесь на список или измените фильтры."
              : "Измените фильтры или попробуйте другое название, услугу либо район."}
            action={mode === "map" || hasActiveFilters ? <div className="discovery-empty-actions">
              {mode === "map" && <button type="button" className="button secondary" onClick={() => updateParam("mode", "list")}>Показать списком</button>}
              {nearby && expandedRadius && <button type="button" className="button secondary" onClick={() => updateParam("radiusKm", String(expandedRadius))}>Увеличить радиус до {expandedRadius} км</button>}
              {(searchParams.has("minPriceMinor") || searchParams.has("maxPriceMinor")) && <button type="button" className="button secondary" onClick={clearPriceFilters}>Очистить цену</button>}
              {hasActiveFilters && <button type="button" className="button secondary" onClick={clearFilters}>Сбросить фильтры</button>}
            </div> : undefined}
          />
        )}
      </Load>
      {mode === "list" && (nextCursor ?? publicData.data?.nextCursor) && <div className="discovery-more">
        {moreError && <p role="alert">{moreError}</p>}
        <button type="button" className="button secondary" disabled={moreLoading} onClick={() => void loadMore()}>{moreLoading ? "Загружаем…" : "Показать ещё"}</button>
      </div>}
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
    setUrl("");
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
        else URL.revokeObjectURL(local);
      })
      .catch(() => { if (alive) setUrl(""); });
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
  colorModeOverride,
}: {
  salon: Salon;
  catalog?: Catalog;
  preview?: boolean;
  colorModeOverride?: "light" | "dark";
}) {
  const auth = useAuth();
  const theme = normalizeStyle(s.style ?? s.draftStyle);
  const [galleryOpen, setGalleryOpen] = useState<number | null>(null);
  const useV2 = auth.storefrontThemesV2;
  const accent = theme.accent;
  const colorMode = colorModeOverride ?? theme.colorMode;
  const discovery = s.discoveryProfile ?? s.discoveryDraft;
  const fullDescription = discovery?.description || theme.description;
  const contactPhone = s.contact.replace(/[^\d+]/g, "");
  const canCall = contactPhone.replace(/\D/g, "").length >= 6;
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
      useV2 && theme.galleryMediaIds.length && discovery?.showGallery !== false ? (
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
      className={`storefront accent-${accent} mode-${colorMode} ${useV2 ? `storefront-v2 theme-${theme.themePreset}` : "storefront-legacy"}`}
      style={storefrontTokenStyle(colorMode, theme.accent)}
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
          {s.location ? <a className="storefront-address-link" href={`https://www.openstreetmap.org/?mlat=${s.location.latitude}&mlon=${s.location.longitude}#map=16/${s.location.latitude}/${s.location.longitude}`} target="_blank" rel="noreferrer">{s.address}<small>Открыть на карте</small></a> : <span className="storefront-address-link">{s.address}</span>}
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
      {fullDescription && <p className="salon-description">{fullDescription}</p>}
      <div className="contact-line">
        <span>✦ {canCall ? <a href={`tel:${contactPhone}`}>{s.contact}</a> : s.contact}</span>
        <span>Часовой пояс: {timezoneLabel(s.timezone)}</span>
      </div>
      {catalog &&
        (useV2 ? theme.sectionOrder : ["services", "staff"]).map(
          (name) => section[name as keyof typeof section],
        )}
      {discovery?.showHours !== false && !!s.hours?.length && <section className="storefront-section storefront-hours">
        <div className="section-head"><h2>Часы работы</h2><span className="muted">{timezoneLabel(s.timezone)}</span></div>
        <dl>{s.hours.map((day) => <div key={day.weekday}><dt>{["", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"][day.weekday]}</dt><dd>{day.intervals.length ? day.intervals.map((interval) => `${interval.start}–${interval.end}`).join(", ") : "Выходной"}</dd></div>)}</dl>
      </section>}
      {discovery?.showRating !== false && s.rating && <section className="storefront-section storefront-rating" aria-label={`Рейтинг салона ${s.rating.average} из 5 по ${s.rating.count} оценкам`}>
        <span aria-hidden="true">★</span><strong>{s.rating.average.toLocaleString("ru-RU")}</strong><small>по {plural(s.rating.count, "оценке", "оценкам", "оценкам")}</small>
      </section>}
      {discovery?.showLinks && !!s.socialLinks?.length && <section className="storefront-section storefront-links">
        <div className="section-head"><h2>Ссылки салона</h2></div>
        <div>{s.socialLinks.map((link) => <a key={link.id} href={link.url} target="_blank" rel="noopener noreferrer nofollow">{link.label || ({ website: "Сайт", max: "MAX", vk: "ВКонтакте", telegram: "Telegram", instagram: "Instagram", tiktok: "TikTok", other: "Ссылка" }[link.kind])}<Icon name="arrow" size={14} /></a>)}</div>
      </section>}
      {s.location && <section className="storefront-section storefront-location">
        <div className="section-head"><h2>Расположение</h2><span className="muted">{s.location.metroStations.length ? s.location.metroStations.join(" · ") : s.location.district}</span></div>
        <p>{s.location.address}</p><a className="button secondary" href={`https://www.openstreetmap.org/?mlat=${s.location.latitude}&mlon=${s.location.longitude}#map=16/${s.location.latitude}/${s.location.longitude}`} target="_blank" rel="noreferrer">Открыть в OpenStreetMap <Icon name="arrow" size={14} /></a>
      </section>}
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
      {!preview && <Link className="storefront-booking-dock" to={`/s/${s.publicCode}/book`}>Записаться <Icon name="arrow" size={16} /></Link>}
    </div>
  );
}
export function SalonPage() {
  const { code } = useParams();
  const [section, setSection] = useState<"services" | "visits" | "bonuses">("services");
  const location = useLocation();
  const navigationState = location.state as { from?: string } | null;
  const backTo = navigationState?.from ?? "/me/salons";
  const { resolvedMode } = useColorMode();
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
        <BackLink to={backTo} label="К списку салонов" />
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
function SalonPreferences({ salon }: { salon: { id: string; name: string } }) {
  const data = useApi<Preference>(`/me/salons/${salon.id}/preferences`);
  const [prefs, setPrefs] = useState<Preference>();
  const a = useAction();
  const baseline = useRef<Preference | undefined>(undefined);
  useEffect(() => {
    const next = data.data;
    if (!next) return;
    const previous = baseline.current;
    baseline.current = next;
    setPrefs(local => {
      if (!local || !previous) return next;
      const changes = Object.keys(local).filter(key => key !== 'version' && local[key as keyof Preference] !== previous[key as keyof Preference]);
      return { ...next, ...Object.fromEntries(changes.map(key => [key, local[key as keyof Preference]])) };
    });
  }, [data.data]);
  return (
    <details className="panel salon-preferences-card">
      <summary>
        <span>
          <strong>{salon.name}</strong>
          <small>Согласие на купоны из этого салона</small>
        </span>
        <span className="salon-preferences-state">
          {!prefs ? "Загрузка…" : prefs.partnerAllowed ? "Разрешено" : "Выключено"}
        </span>
      </summary>
      <div className="salon-preferences-content">
        <Load {...data}>
          {prefs && (
            <>
              <Check
                label="Разрешить выдачу партнёрских купонов после визита в этот салон"
                checked={prefs.partnerAllowed}
                onChange={(v) => setPrefs({ ...prefs, partnerAllowed: v })}
              />
              <p className="small muted salon-preferences-help">
                Это отдельное согласие на участие салона в партнёрской программе. Оно не включает рекламные сообщения.
              </p>
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
      </div>
    </details>
  );
}

interface NotificationPreferences {
  serviceEnabled: boolean;
  remindersEnabled: boolean;
  liveWindowEnabled: boolean;
  version: number;
  salons: Array<{
    id: string;
    name: string;
    excludedService: boolean;
    excludedReminder: boolean;
    excludedLiveWindow: boolean;
  }>;
}

function SalonNotificationSettings() {
  const data = useApi<NotificationPreferences>("/me/notification-preferences");
  const [draft, setDraft] = useState<NotificationPreferences>();
  const action = useAction();
  useEffect(() => setDraft(data.data), [data.data]);
  const exceptionCount = draft?.salons.reduce((count, salon) => count + [salon.excludedService, salon.excludedReminder, salon.excludedLiveWindow].filter(Boolean).length, 0) ?? 0;
  return (
    <section className="panel notification-settings">
      <h2>Уведомления по салонам</h2>
      <p>Переключатели применяются ко всем салонам. Для отдельных салонов можно настроить исключения.</p>
      <Load {...data}>
        {draft && (
          <>
            <Check label="Изменения и отмены записи" checked={draft.serviceEnabled} disabled={action.busy} onChange={(serviceEnabled) => setDraft({ ...draft, serviceEnabled })} />
            <Check label="Напоминания о записи за 24 и 2 часа" checked={draft.remindersEnabled} disabled={action.busy} onChange={(remindersEnabled) => setDraft({ ...draft, remindersEnabled })} />
            <Check label="Предложения свободного времени из листа ожидания" checked={draft.liveWindowEnabled} disabled={action.busy} onChange={(liveWindowEnabled) => setDraft({ ...draft, liveWindowEnabled })} />
            <details className="notification-exclusions">
              <summary>Исключения{exceptionCount ? ` · ${exceptionCount}` : ""}</summary>
              <p className="small muted">Показываем салоны, где у вас когда-либо была запись. Исключение отключает только выбранный тип уведомлений.</p>
              {draft.salons.length ? (
                <div className="notification-exclusion-list">
                  {draft.salons.map((salon) => (
                    <details className="notification-exclusion-card" key={salon.id}>
                      <summary>
                        <strong>{salon.name}</strong>
                        <small>{[salon.excludedService, salon.excludedReminder, salon.excludedLiveWindow].filter(Boolean).length ? "Есть исключения" : "Все уведомления включены"}</small>
                      </summary>
                      <Check label="Не получать сообщения об изменениях записи" checked={salon.excludedService} disabled={action.busy} onChange={(excludedService) => setDraft({ ...draft, salons: draft.salons.map((item) => item.id === salon.id ? { ...item, excludedService } : item) })} />
                      <Check label="Не получать напоминания" checked={salon.excludedReminder} disabled={action.busy} onChange={(excludedReminder) => setDraft({ ...draft, salons: draft.salons.map((item) => item.id === salon.id ? { ...item, excludedReminder } : item) })} />
                      <Check label="Не получать предложения свободного времени" checked={salon.excludedLiveWindow} disabled={action.busy} onChange={(excludedLiveWindow) => setDraft({ ...draft, salons: draft.salons.map((item) => item.id === salon.id ? { ...item, excludedLiveWindow } : item) })} />
                    </details>
                  ))}
                </div>
              ) : (
                <p className="small muted">Список появится после первой записи в салон.</p>
              )}
            </details>
            {action.feedback}
            <button className="button secondary" disabled={action.busy} onClick={() => void action.run(async () => {
              await api("/me/notification-preferences", "PATCH", {
                serviceEnabled: draft.serviceEnabled,
                remindersEnabled: draft.remindersEnabled,
                liveWindowEnabled: draft.liveWindowEnabled,
                excludedServiceSalonIds: draft.salons.filter((salon) => salon.excludedService).map((salon) => salon.id),
                excludedReminderSalonIds: draft.salons.filter((salon) => salon.excludedReminder).map((salon) => salon.id),
                excludedLiveWindowSalonIds: draft.salons.filter((salon) => salon.excludedLiveWindow).map((salon) => salon.id),
                expectedVersion: draft.version,
                textVersion: "notifications-v1",
              });
              refreshData();
            }, "Настройки уведомлений сохранены")}>Сохранить настройки</button>
          </>
        )}
      </Load>
    </section>
  );
}

interface MarketingPreferences {
  enabled: boolean;
  version: number;
  salons: Array<{ id: string; name: string; excluded: boolean }>;
}

function MarketingSettings() {
  const data = useApi<MarketingPreferences>("/me/marketing-preferences");
  const [draft, setDraft] = useState<MarketingPreferences>();
  const action = useAction();
  useEffect(() => setDraft(data.data), [data.data]);
  return (
    <section className="panel marketing-settings">
      <h2>Предложения салонов</h2>
      <p>Одно общее согласие на рекламные предложения в MAX. Можно исключить отдельные салоны.</p>
      <Load {...data}>
        {draft && (
          <>
            <Check
              label="Получать рекламные предложения салонов в MAX"
              checked={draft.enabled}
              disabled={action.busy}
              onChange={(enabled) => setDraft({ ...draft, enabled })}
            />
            <details className="marketing-exclusions">
              <summary>Исключения{draft.salons.some((salon) => salon.excluded) ? ` · ${draft.salons.filter((salon) => salon.excluded).length}` : ""}</summary>
              <p className="small muted">Здесь показаны салоны, где у вас когда-либо была запись. Их предложения не будут приходить, пока салон находится в исключениях.</p>
              {draft.salons.length ? (
                <div className="marketing-exclusion-list">
                  {draft.salons.map((salon) => (
                    <Check
                      key={salon.id}
                      label={salon.name}
                      checked={salon.excluded}
                      disabled={action.busy}
                      onChange={(excluded) => setDraft({
                        ...draft,
                        salons: draft.salons.map((item) => item.id === salon.id ? { ...item, excluded } : item),
                      })}
                    />
                  ))}
                </div>
              ) : (
                <p className="small muted">Список появится после первой записи в салон.</p>
              )}
            </details>
            {action.feedback}
            <button
              className="button secondary"
              disabled={action.busy}
              onClick={() => void action.run(async () => {
                await api("/me/marketing-preferences", "PATCH", {
                  enabled: draft.enabled,
                  excludedSalonIds: draft.salons.filter((salon) => salon.excluded).map((salon) => salon.id),
                  expectedVersion: draft.version,
                  textVersion: "marketing-v1",
                });
                refreshData();
              }, "Настройки предложений сохранены")}
            >Сохранить настройки</button>
          </>
        )}
      </Load>
    </section>
  );
}

export function ProfilePage() {
  const auth = useAuth();
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  const [selectedSalon, setSelectedSalon] = useState<string | null>(null);
  const [remoteSelectedSalon, setRemoteSelectedSalon] = useState<Salon | null>(null);
  const [salonPickerOpen, setSalonPickerOpen] = useState(false);
  const [salonQuery, setSalonQuery] = useState("");
  const [extraSalons, setExtraSalons] = useState<Salon[]>([]);
  const [nextCatalogCursor, setNextCatalogCursor] = useState<string | null | undefined>(undefined);
  const [loadingMoreSalons, setLoadingMoreSalons] = useState(false);
  const [moreSalonsError, setMoreSalonsError] = useState("");
  const selectTheme = (value: "light" | "dark") => {
    setTheme(value);
    document.documentElement.dataset.theme = value;
    try { localStorage.setItem("ryadom-theme", value); } catch { /* Storage may be unavailable in a WebView. */ }
  };
  const data = useApi<Items<Salon>>("/me/salons");
  const all = useApi<Items<Salon>>("/public/salons");
  const searchedSalons = useApi<Items<Salon>>(salonQuery.trim() ? `/public/salons?query=${encodeURIComponent(salonQuery.trim())}` : null);
  const a = useAction();
  const salons = [
    ...(data.data?.items ?? []),
    ...(all.data?.items ?? []),
    ...extraSalons,
    ...(remoteSelectedSalon ? [remoteSelectedSalon] : []),
  ].filter((v, i, s) => s.findIndex((t) => t.id === v.id) === i);
  const catalogCursor = nextCatalogCursor === undefined ? all.data?.nextCursor : nextCatalogCursor;
  const loadMoreSalons = async () => {
    if (!catalogCursor || loadingMoreSalons) return;
    setLoadingMoreSalons(true);
    setMoreSalonsError("");
    try {
      const page = await api<Items<Salon>>(`/public/salons?limit=100&cursor=${encodeURIComponent(catalogCursor)}`);
      setExtraSalons((previous) => [...previous, ...page.items]);
      setNextCatalogCursor(page.nextCursor);
    } catch (error) {
      setMoreSalonsError(error instanceof Error ? error.message : "Не удалось загрузить салоны");
    } finally {
      setLoadingMoreSalons(false);
    }
  };
  const activeSalonId = selectedSalon === "all" ? "all" : salons.some((salon) => salon.id === selectedSalon) ? selectedSalon : salons[0]?.id ?? "all";
  const visibleSalons = activeSalonId === "all" ? salons : salons.filter((salon) => salon.id === activeSalonId);
  const matchingSalons = [...salons, ...(searchedSalons.data?.items ?? [])]
    .filter((salon, index, allSalons) => allSalons.findIndex((item) => item.id === salon.id) === index)
    .filter((salon) => salon.name.toLocaleLowerCase("ru-RU").includes(salonQuery.trim().toLocaleLowerCase("ru-RU")));
  const partnerSalons = useApi<MarketingPreferences>("/me/marketing-preferences");
  const partnerEligibleSalons = partnerSalons.data?.salons ?? [];
  return (
    <>
      <PageTitle
        eyebrow="ВАШИ НАСТРОЙКИ"
        title="Профиль и сообщения"
        description="Сервисные сообщения и реклама настраиваются отдельно."
      />
      <section className="panel appearance-settings">
        <div><h2>Внешний вид</h2><p>Тема «Как в системе» меняется вместе с настройками устройства.</p></div>
        <ThemeModePicker />
      </section>
      <div className="profile-links"><a href="#salon-settings">Настройки салонов</a><Link to="/me/events">События</Link><Link to="/me/waitlist">Запросы «Живого окна»</Link><Link to="/me/offers">Предложения</Link><Link to="/create-salon">Создать салон</Link></div>
      {!!auth.me?.memberships.length && <section className="panel"><h2>Рабочие кабинеты</h2><div className="profile-links">{auth.me.memberships.map((membership) => <Link key={membership.id} to={`/work/${membership.tenantId}/calendar`}>{membership.tenantName} · {membership.role === "owner" ? "владелец" : membership.role === "admin" ? "администратор" : "мастер"}</Link>)}</div></section>}
      <section id="salon-settings" className="salon-settings-section">
      <h2>Настройки по салонам</h2>
      <div className="salon-picker">
        <button type="button" className="salon-picker-trigger" aria-label="Выбрать салон для настроек" aria-expanded={salonPickerOpen} onClick={() => {setSalonPickerOpen(!salonPickerOpen);setSalonQuery("");}}>
          <span>{activeSalonId === "all" ? "Все салоны" : salons.find((salon) => salon.id === activeSalonId)?.name ?? "Выберите салон"}</span>
          <span aria-hidden="true">⌄</span>
        </button>
        {salonPickerOpen && <div className="salon-picker-menu">
          <input autoFocus type="search" aria-label="Поиск салона в настройках" placeholder="Найти салон" value={salonQuery} onChange={(event) => setSalonQuery(event.target.value)} onKeyDown={(event) => {if (event.key === "Escape") setSalonPickerOpen(false);}} />
          <div className="salon-picker-options">
            <button type="button" aria-pressed={activeSalonId === "all"} onClick={() => {setSelectedSalon("all");setSalonPickerOpen(false);}}>Все салоны <small>{salons.length}</small></button>
            {matchingSalons.slice(0, 40).map((salon) => <button type="button" key={salon.id} aria-pressed={activeSalonId === salon.id} onClick={() => {setRemoteSelectedSalon(salon);setSelectedSalon(salon.id);setSalonPickerOpen(false);}}>{salon.name}</button>)}
            {!matchingSalons.length && <p className="small muted">Салон не найден</p>}
            {matchingSalons.length > 40 && <p className="small muted">Уточните поиск, чтобы увидеть остальные салоны.</p>}
          </div>
        </div>}
      </div>
      <div className="two-columns salon-preferences-grid">
        {visibleSalons.map((s) => (
          <SalonPreferences key={s.id} salon={s} />
        ))}
      </div>
      {activeSalonId === "all" && catalogCursor && <button type="button" className="button secondary" disabled={loadingMoreSalons} onClick={() => void loadMoreSalons()}>{loadingMoreSalons ? "Загружаем…" : "Показать ещё салоны"}</button>}
      {moreSalonsError && <div className="notice error" role="alert">{moreSalonsError}</div>}
      </section>
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
      <MarketingSettings />
      <SalonNotificationSettings />
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
