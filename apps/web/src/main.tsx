import React from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  Link,
  useNavigate,
  useLocation,
  useParams,
  Navigate,
} from "react-router-dom";
import { AuthProvider, useAuth } from "./api";
import { Icon, labels } from "./ui";
import {
  BookingsPage,
  DiscoverPage,
  SalonPage,
  BookingForm,
  BookingPage,
  EventsPage,
  OffersPage,
  ProfilePage,
  CreateSalonPage,
  InvitePage,
} from "./personal";
import {
  WorkCalendar,
  CustomersPage,
  CustomerPage,
  CatalogPage,
  SchedulePage,
  SettingsPage,
  AccessPage,
  AnalyticsPage,
  AuditPage,
} from "./work";
import { PartnersPage } from "./partners";
import { LoyaltyPage, LoyaltySettingsPage } from "./loyalty";
import { PromotionsWorkPage } from './promotions-ui';
import { LiveWindowOfferPage, LiveWindowWorkPage, WaitlistForm, WaitlistPage } from "./live-window-ui";
import "./style.css";
import "./design-system.css";

try {
  document.documentElement.dataset.theme = localStorage.getItem("ryadom-theme") === "dark" ? "dark" : "light";
} catch {
  document.documentElement.dataset.theme = "light";
}

function App() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // A /work/<id> path can outlive the access that put it there: switching accounts keeps
  // the old URL, and membership can be revoked. Treat it as a workspace only while the
  // signed-in person actually belongs to it, so nobody sees someone else's menu.
  const pathTenantId = location.pathname.match(/^\/work\/([^/]+)/)?.[1];
  const member = auth.me?.memberships.find((m) => m.tenantId === pathTenantId);
  const tenantId = member ? pathTenantId : undefined;
  // A deep link resolves to a path while AuthProvider sits outside the router,
  // so the router performs the navigation once the path is known.
  React.useEffect(() => {
    if (!auth.launchPath) return;
    navigate(auth.launchPath, { replace: true });
    auth.clearLaunchPath();
  }, [auth.launchPath]);
  React.useEffect(() => {
    const button = window.WebApp?.BackButton;
    if (!button) return;
    const back = () => {
      const historyIndex = Number(window.history.state?.idx ?? 0);
      if (historyIndex > 0) navigate(-1);
      else window.WebApp?.close?.();
    };
    // Keep MAX's native back control visible inside the app. At the root of the
    // WebView history it becomes the expected Android exit affordance.
    if (location.pathname === "/") button.hide();
    else button.show();
    button.onClick(back);
    return () => button.offClick(back);
  }, [location.pathname]);
  if (auth.loading)
    return (
      <div className="boot">
        <div className="brand-mark">р.</div>
        <p>Собираем ваши салоны…</p>
      </div>
    );
  if (auth.me && pathTenantId && !member)
    return <Navigate to="/me/bookings" replace />;
  if (!auth.me)
    return (
      <div className="login-page">
        <div className="login-art">
          <div className="wordmark">
            <span className="brand-mark">р.</span>рядом
            <span className="max-chip">в MAX</span>
          </div>
          <div>
            <span className="eyebrow">ВАШЕ ВРЕМЯ ДЛЯ СЕБЯ</span>
            <h1>
              Любимые места.
              <br />
              Всё — рядом.
            </h1>
            <p>
              Записи, мастера и приятные предложения ваших салонов. В одном
              приложении.
            </p>
          </div>
          <div className="login-orbit">
            <span>✦</span>
            <span>забота о себе</span>
            <span>в вашем ритме</span>
          </div>
          <small>Салоны в MAX · услуги оплачиваются в салоне</small>
        </div>
        <div className="login-panel">
          <span className="eyebrow">ДОБРО ПОЖАЛОВАТЬ</span>
          <h2>
            {auth.demo
              ? "Познакомимся с приложением"
              : "Откройте приложение в MAX"}
          </h2>
          <p>
            {auth.demo
              ? "Это локальное демо с вымышленными данными. Выберите роль, чтобы пройти нужный сценарий."
              : "Для личных записей и рабочего кабинета нужен подтверждённый вход через MAX."}
          </p>
          {auth.error && <div className="notice error">{auth.error}</div>}
          {auth.demo ? (
            <div className="persona-list">
              {[
                [
                  "client",
                  "Клиент",
                  "Записаться, перенести визит, получить купон",
                  "user",
                ],
                [
                  "owner-a",
                  "Владелец · Линия",
                  "Управление студией волос и партнёрствами",
                  "salons",
                ],
                [
                  "owner-b",
                  "Владелец · Точка",
                  "Управление nail studio и согласование акции",
                  "salons",
                ],
                [
                  "admin",
                  "Администратор",
                  "Календарь, услуги и CRM студии «Линия»",
                  "calendar",
                ],
                [
                  "master",
                  "Мастер",
                  "Только свои назначения и исходы визитов",
                  "user",
                ],
                [
                  "new-owner",
                  "Новый владелец",
                  "Создать свой салон с нуля",
                  "plus",
                ],
              ].map(([id, title, caption, icon]) => (
                <button
                  key={id}
                  className="persona"
                  onClick={() => void auth.login(id!)}
                >
                  <span className="persona-icon">
                    <Icon name={icon!} />
                  </span>
                  <span>
                    <strong>{title}</strong>
                    <small>{caption}</small>
                  </span>
                  <Icon name="arrow" />
                </button>
              ))}
            </div>
          ) : (
            <a
              className="button primary"
              href={`https://max.ru/${auth.botName}?startapp=home`}
            >
              Открыть MAX
            </a>
          )}
          <p className="muted small">
            Запись не подписывает вас на рекламу. Согласия и уведомления
            настраиваются отдельно.
          </p>
        </div>
      </div>
    );
  const personal = [
    ["/me/salons", "salons", "Мои места"],
    ["/me/bookings", "calendar", "Записи"],
    ["/me/loyalty", "gift", "Бонусы"],
    ["/me/profile", "user", "Профиль"],
    ["/me/offers", "gift", "Предложения"],
    ["/me/events", "bell", "События"],
    ["/me/waitlist", "calendar", "Живое окно"],
  ];
  const work = [
    ["calendar", "calendar", "Календарь"],
    ...(member?.role !== "master"
      ? [
          ["customers", "user", "Клиенты"],
          ["catalog", "salons", "Услуги и мастера"],
          ["schedule", "calendar", "График"],
          ["analytics", "chart", "Статистика"],
        ]
      : []),
    ...(member?.role === "owner"
      ? [
          ["loyalty", "gift", "Лояльность"],
          ["partners", "gift", "Партнёрства"],
          ["promotions", "gift", "Акции"],
          ["settings", "settings", "Настройки"],
          ["staff-access", "user", "Доступ"],
        ]
      : []),
    ...(member?.role !== "master" ? [["audit", "bell", "Журнал"]] : []),
  ].map(([p, i, l]) => [`/work/${tenantId}/${p}`, i, l]);
  if (member?.role === "master") {
    work.push(
      ["/me/salons", "salons", "Мои места"],
      ["/me/bookings", "calendar", "Мои записи"],
      ["/me/profile", "user", "Профиль"],
    );
  }
  return (
    <div className={`app-shell ${tenantId ? "work-shell" : "personal-shell"}`}>
      <header className="mobile-appbar">
        <button type="button" className="mobile-back" aria-label="Назад" onClick={() => {
          if (Number(window.history.state?.idx ?? 0) > 0) navigate(-1);
          else navigate("/me/salons");
        }}><Icon name="arrow" /></button>
        <Link to="/me/salons" className="mobile-wordmark" aria-label="Рядом — мои места">ря<span>дом</span></Link>
        <select
          className="mobile-workspace-select"
          aria-label="Выбрать кабинет"
          value={tenantId ?? "personal"}
          onChange={(event) => {
            if (event.target.value === "change-role") { auth.logout(); return; }
            navigate(event.target.value === "personal" ? "/me/salons" : `/work/${event.target.value}/calendar`);
          }}
        >
          <option value="personal">Личный</option>
          {auth.me.memberships.map((membership) => <option key={membership.id} value={membership.tenantId}>{membership.tenantName} · {labels[membership.role]}</option>)}
          {auth.demo && <option value="change-role">Сменить роль…</option>}
        </select>
        {auth.demo && <button type="button" className="mobile-role-switch" aria-label="Сменить роль" title="Сменить роль" onClick={auth.logout}><Icon name="logout" /></button>}
      </header>
      <aside className="sidebar">
        <Link to="/me/salons" className="wordmark">
          <span className="brand-mark">р.</span>рядом
        </Link>
        <div className="workspace-switch">
          <label>ПРОСТРАНСТВО</label>
          <select
            aria-label="Личный или рабочий кабинет"
            value={tenantId ?? "personal"}
            onChange={(e) =>
              navigate(
                e.target.value === "personal"
                  ? "/me/salons"
                  : `/work/${e.target.value}/calendar`,
              )
            }
          >
            <option value="personal">Личный кабинет</option>
            {auth.me.memberships.map((m) => (
              <option key={m.id} value={m.tenantId}>
                {m.tenantName} · {labels[m.role]}
              </option>
            ))}
          </select>
          {member && <small>{labels[member.role]}</small>}
        </div>
        <nav>
          {(tenantId ? work : personal).map(([to, icon, label]) => (
            <NavLink
              key={to}
              to={to!}
              className={({ isActive }) =>
                `nav-item ${isActive ? "active" : ""}`
              }
            >
              <Icon name={icon!} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Link
            className="add-salon"
            to="/create-salon"
            aria-label="Создать салон"
          >
            <Icon name="plus" />
            <span>Создать салон</span>
          </Link>
          <div className="account">
            <span className="avatar">{auth.me.user.displayName.charAt(0)}</span>
            <div>
              <strong>{auth.me.user.displayName}</strong>
              <small>
                {auth.demo ? "Демонстрационный аккаунт" : "Подтверждённый MAX"}
              </small>
            </div>
            <button
              className="icon-button"
              aria-label={auth.demo ? "Выйти" : "Закрыть приложение"}
              onClick={
                auth.demo ? auth.logout : () => window.WebApp?.close?.()
              }
            >
              <Icon name={auth.demo ? "logout" : "close"} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <span>
            {tenantId
              ? `${member?.tenantName ?? "Салон"} / ${labels[member?.role ?? "owner"]}`
              : "Для вас"}
          </span>
          <div>
            <span className="topbar-date">{new Date().toLocaleDateString("ru-RU", {day:"numeric",month:"long",year:"numeric"})}</span>
            <Link to="/me/events" className="icon-button" aria-label="События">
              <Icon name="bell" />
            </Link>
          </div>
        </header>
        <main key={`${auth.me.user.id}:${tenantId ?? "personal"}`}>
          <Routes>
            <Route path="/" element={<Navigate to="/me/salons" replace />} />
            <Route path="/me/bookings" element={<BookingsPage />} />
            <Route path="/me/salons" element={<DiscoverPage />} />
            <Route path="/s/:code" element={<SalonPage />} />
            <Route path="/s/:code/book" element={<BookingForm />} />
            <Route path="/me/bookings/:id" element={<BookingPage />} />
            <Route
              path="/me/bookings/:id/reschedule"
              element={<BookingForm reschedule />}
            />
            <Route path="/me/events" element={<EventsPage />} />
            <Route path="/me/waitlist" element={<WaitlistPage />} />
            <Route path="/me/waitlist/new" element={<WaitlistForm />} />
            <Route path="/me/live-window/offers/:id" element={<LiveWindowOfferPage />} />
            <Route path="/me/offers" element={<OffersPage />} />
            <Route path="/me/loyalty" element={<LoyaltyPage />} />
            <Route path="/work/:t/loyalty" element={<LoyaltySettingsPage />} />
            <Route path="/me/profile" element={<ProfilePage />} />
            <Route path="/create-salon" element={<CreateSalonPage />} />
            <Route path="/invite/:token" element={<InvitePage />} />
            <Route path="/work/:t/calendar" element={<WorkCalendar />} />
            <Route
              path="/work/:t/bookings/new"
              element={<BookingForm work />}
            />
            <Route
              path="/work/:t/bookings/:id"
              element={<BookingPage work />}
            />
            <Route
              path="/work/:t/bookings/:id/reschedule"
              element={<BookingForm work reschedule />}
            />
            <Route path="/work/:t/customers" element={<CustomersPage />} />
            <Route path="/work/:t/customers/:id" element={<CustomerPage />} />
            <Route path="/work/:t/catalog" element={<CatalogPage />} />
            <Route path="/work/:t/schedule" element={<SchedulePage />} />
            <Route path="/work/:t/analytics" element={<AnalyticsPage />} />
            <Route path="/work/:t/live-window" element={<LiveWindowWorkPage />} />
            <Route path="/work/:t/settings" element={<SettingsPage />} />
            <Route path="/work/:t/staff-access" element={<AccessPage />} />
            <Route path="/work/:t/partners" element={<PartnersPage />} />
            <Route path="/work/:t/promotions" element={<PromotionsWorkPage />} />
            <Route path="/work/:t/audit" element={<AuditPage />} />
            <Route
              path="*"
              element={
                <div className="empty">
                  <h2>Страница не найдена</h2>
                  <Link to="/me/salons">В личный кабинет</Link>
                </div>
              }
            />
          </Routes>
        </main>
        <footer>
          Рядом · салоны в MAX{" "}
          <span>
            Время визитов и графиков — в часовом поясе выбранного салона.
          </span>
        </footer>
      </div>
    </div>
  );
}
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="boot">
        <h2>Не удалось открыть экран</h2>
        <p>Обновите страницу или заново откройте приложение в MAX.</p>
        <button className="button primary" onClick={() => location.reload()}>
          Обновить
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <AuthProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AuthProvider>
  </ErrorBoundary>,
);
