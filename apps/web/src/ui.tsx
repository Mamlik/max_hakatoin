import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { Link } from "react-router-dom";
import { api, refreshData } from "./api";
export const money = (n?: number | null) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("ru-RU", {
        style: "currency",
        currency: "RUB",
        maximumFractionDigits: 0,
      }).format(n / 100);
export const dateTime = (v: string, zone = "Europe/Moscow") =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: zone,
  }).format(new Date(v));
export const dayISO = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const TIMEZONES = [
  ["Europe/Kaliningrad", "МСК−1", "Калининград"],
  ["Europe/Moscow", "МСК", "Москва"],
  ["Europe/Samara", "МСК+1", "Самара"],
  ["Asia/Yekaterinburg", "МСК+2", "Екатеринбург"],
  ["Asia/Omsk", "МСК+3", "Омск"],
  ["Asia/Krasnoyarsk", "МСК+4", "Красноярск"],
  ["Asia/Irkutsk", "МСК+5", "Иркутск"],
  ["Asia/Yakutsk", "МСК+6", "Якутск"],
  ["Asia/Vladivostok", "МСК+7", "Владивосток"],
  ["Asia/Magadan", "МСК+8", "Магадан"],
  ["Asia/Kamchatka", "МСК+9", "Камчатка"],
] as const;
export const timezoneLabel = (zone: string) => {
  const item = TIMEZONES.find(([value]) => value === zone);
  return item ? `${item[1]} · ${item[2]}` : zone;
};
export function TimezonePicker({
  defaultValue = "Europe/Moscow",
}: {
  defaultValue?: string;
}) {
  // Вариантов 11, в карусель влезает 3-4. Выбранный надо доводить до экрана:
  // иначе владелец дальневосточного салона видит карусель, где ничего не
  // выбрано, а стрелками с клавиатуры каждый второй вариант уходит за край
  // (браузер везёт к фокусу скрытый radio нулевого размера, а не саму плашку).
  const box = useRef<HTMLDivElement>(null);
  const reveal = useCallback(() => {
    const scroller = box.current;
    const active = scroller?.querySelector("input:checked")?.parentElement;
    if (!scroller || !active) return;
    const view = scroller.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (item.left >= view.left - 1 && item.right <= view.right + 1) return;
    scroller.scrollLeft +=
      item.left - view.left - (scroller.clientWidth - active.clientWidth) / 2;
  }, []);
  useEffect(reveal, [reveal, defaultValue]);
  return (
    <Field label="Часовой пояс" hint="Листайте по горизонтали и выберите свой регион.">
      <div
        className="timezone-picker"
        role="radiogroup"
        aria-label="Часовой пояс"
        ref={box}
        onChange={reveal}
      >
        {TIMEZONES.map(([value, offset, city]) => (
          <label key={value}>
            <input
              type="radio"
              name="timezone"
              value={value}
              defaultChecked={value === defaultValue}
              required
            />
            <span>
              <strong>{offset}</strong>
              <small>{city}</small>
            </span>
          </label>
        ))}
      </div>
    </Field>
  );
}
export const labels: Record<string, string> = {
  confirmed: "Подтверждена",
  completed: "Завершён",
  cancelled: "Отменена",
  no_show: "Неявка",
  issued: "Доступен",
  reserved: "Зарезервирован",
  redeemed: "Использован",
  expired: "Истёк",
  revoked: "Отозван",
  owner: "Владелец",
  admin: "Администратор",
  master: "Мастер",
  draft: "Черновик",
  published: "Опубликован",
  paused: "На паузе",
  archived: "В архиве",
  active: "Активна",
  proposed: "На согласовании",
  rejected: "Отклонена",
  ended: "Завершена",
  exhausted: "Лимит исчерпан",
  pending: "Ожидает",
  accepted: "Принято",
  client_confirmed: "Клиент подтвердил",
  sent: "Принято MAX",
  scheduled: "Ожидает отправки",
  suppressed: "Отправка отменена",
  failed: "Ошибка доставки",
  retry_wait: "Ожидает повтора",
  sending: "Отправляется",
  stopped: "Бот остановлен",
  removed: "Диалог удалён",
  unknown: "Бот ещё не запущен",
};
export function Badge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{labels[status] ?? status}</span>;
}
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="4" />
        <path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2" />
      </>
    ),
    salons: (
      <>
        <path d="M3 10h18l-2-6H5l-2 6Zm1 0v10h16V10M9 20v-7h6v7" />
        <path d="M3 10c0 4 6 4 6 0 0 4 6 4 6 0 0 4 6 4 6 0" />
      </>
    ),
    gift: (
      <>
        <rect x="3" y="8" width="18" height="5" rx="1" />
        <path d="M5 13v8h14v-8M12 8v13M12 8C4 8 5 1 9 3l3 5Zm0 0c8 0 7-7 3-5l-3 5Z" />
      </>
    ),
    bell: (
      <>
        <path d="M5 17h14l-2-4V9a5 5 0 0 0-10 0v4l-2 4ZM10 21h4" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="7" r="4" />
        <path d="M4 21v-3a8 8 0 0 1 16 0v3" />
      </>
    ),
    chart: (
      <>
        <path d="M4 3v18h17M8 17v-5m5 5V7m5 10V3" />
      </>
    ),
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" fill="currentColor" />
        <circle cx="16" cy="17" r="3" fill="currentColor" />
      </>
    ),
    arrow: <path d="m9 5 7 7-7 7" />,
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m4 12 5 5L20 6" />,
    star: (
      <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z" />
    ),
    logout: (
      <>
        <path d="M10 4H4v16h6m4-12 4 4-4 4m-5-4h12" />
      </>
    ),
    close: <path d="M6 6l12 12M18 6 6 18" />,
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 5 5" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.salons}
    </svg>
  );
}
export function PageTitle({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-title">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </header>
  );
}
export function Empty({
  title = "Здесь пока пусто",
  text,
  action,
}: {
  title?: string;
  text?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name="calendar" size={30} />
      </span>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}
export function Load({
  loading,
  error,
  reload,
  children,
}: {
  loading: boolean;
  error?: string;
  reload?: () => void;
  children: ReactNode;
}) {
  if (loading)
    return (
      <div className="skeleton-grid" aria-label="Загрузка">
        <div />
        <div />
        <div />
      </div>
    );
  if (error)
    return (
      <div className="notice error" role="alert">
        {error}
        {reload && (
          <div className="inline-actions">
            {/* Без этого единственный выход из сбоя — уйти на другой экран. */}
            <button className="button secondary compact" onClick={reload}>
              Повторить
            </button>
          </div>
        )}
      </div>
    );
  return <>{children}</>;
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function ChoiceGroup({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <fieldset className="field choice-field">
      <legend>{label}</legend>
      {children}
      {hint && <small>{hint}</small>}
    </fieldset>
  );
}
// The native file input renders a browser-locale button that ignores the design system.
export function FilePick({
  accept,
  disabled,
  onPick,
  label = "Выбрать файл",
}: {
  accept: string;
  disabled?: boolean;
  onPick: (file?: File) => void;
  label?: string;
}) {
  return (
    <label className={`file-pick${disabled ? " disabled" : ""}`}>
      <Icon name="plus" />
      <span>{label}</span>
      <input
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={(e) => {
          onPick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </label>
  );
}
// Russian count agreement: 1 услуга / 2 услуги / 5 услуг.
export function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  const form =
    a >= 11 && a <= 14 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  return `${n} ${form}`;
}
export function Check({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="section-head">
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
export function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  const run = async (fn: () => Promise<unknown>, message = "Сохранено") => {
    if (busy) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await fn();
      refreshData();
      setSuccess(message);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось выполнить действие",
      );
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    error,
    success,
    run,
    setError,
    feedback: (
      <>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {success && (
          <div className="notice success" role="status">
            {success}
          </div>
        )}
      </>
    ),
  };
}
export function SimpleForm({
  fields,
  onSubmit,
  submit = "Сохранить",
  submitDisabled = false,
  initial = {},
  children,
}: {
  fields: {
    name: string;
    label: string;
    type?: string;
    required?: boolean;
    hint?: string;
  }[];
  onSubmit: (values: Record<string, string>) => Promise<unknown>;
  submit?: string;
  submitDisabled?: boolean;
  initial?: Record<string, string | number>;
  children?: ReactNode;
}) {
  const action = useAction();
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        const values = Object.fromEntries(
          new FormData(e.currentTarget).entries(),
        ) as Record<string, string>;
        void action.run(() => onSubmit(values));
      }}
    >
      {fields.map((f) => (
        <Field key={f.name} label={f.label} hint={f.hint}>
          {f.type === "textarea" ? (
            <textarea
              name={f.name}
              defaultValue={initial[f.name]}
              required={f.required ?? true}
              rows={3}
            />
          ) : (
            <input
              name={f.name}
              type={f.type ?? "text"}
              defaultValue={initial[f.name]}
              required={f.required ?? true}
            />
          )}
        </Field>
      ))}
      {children}
      {action.feedback}
      <button className="button primary" disabled={action.busy || submitDisabled}>
        {action.busy ? "Сохраняем…" : submit}
      </button>
    </form>
  );
}
export function CommandButton({
  path,
  body,
  label,
  danger = false,
  onDone,
}: {
  path: string;
  body: unknown;
  label: string;
  danger?: boolean;
  onDone?: () => void;
}) {
  const a = useAction();
  return (
    <div className="command">
      <button
        className={`button ${danger ? "danger" : "secondary"}`}
        disabled={a.busy}
        onClick={() =>
          void a.run(async () => {
            await api(path, "POST", body);
            onDone?.();
          })
        }
      >
        {a.busy ? "Подождите…" : label}
      </button>
      {a.feedback}
    </div>
  );
}
export function BackLink({
  to,
  label = "Назад",
}: {
  to: string;
  label?: string;
}) {
  return (
    <Link className="back-link" to={to}>
      ← {label}
    </Link>
  );
}
