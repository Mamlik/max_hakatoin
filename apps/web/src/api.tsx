import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Me } from "./types";
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
    public status = 0,
  ) {
    super(message);
  }
}

let session = "";
let onUnauthorized = () => {};

export function setSession(value: string) {
  session = value;
}

export const currentSession = () => session;

export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (session) headers.Authorization = `Bearer ${session}`;
  if (method !== "GET") headers["Idempotency-Key"] = key ?? crypto.randomUUID();
  if (body !== undefined && !(body instanceof FormData))
    headers["Content-Type"] = "application/json";

  const request = () =>
    fetch(path.startsWith("/api/") ? path : `/api/v1${path}`, {
      method,
      headers,
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });

  let response: Response;
  try {
    response = await request();
  } catch {
    try {
      response = await request();
    } catch {
      throw new ApiError(
        "NETWORK_UNKNOWN",
        "Нет связи с сервером. Результат действия пока неизвестен: проверьте список перед повторной отправкой.",
      );
    }
  }

  const payload = await response.json().catch(() => ({
    error: {
      code: "INVALID_RESPONSE",
      message: "Не удалось прочитать ответ сервера",
    },
  }));

  if (!response.ok) {
    if (response.status === 401 && session) onUnauthorized();
    throw new ApiError(
      payload.error?.code ?? "ERROR",
      payload.error?.message ?? "Ошибка запроса",
      payload.error?.details ?? {},
      response.status,
    );
  }

  return payload.data as T;
}

export function refreshData() {
  window.dispatchEvent(new Event("salon-data-changed"));
}

export function useApi<T>(path: string | null, poll = false) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((current) => current + 1), []);

  useEffect(() => {
    setData(undefined);
    setError("");
    setLoading(true);
  }, [path]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!path) {
        if (alive) setLoading(false);
        return;
      }
      try {
        const result = await api<T>(path);
        if (alive) {
          setData(result);
          setError("");
        }
      } catch (cause) {
        if (alive) {
          setError(cause instanceof Error ? cause.message : "Ошибка");
          setData(undefined);
        }
      } finally {
        if (alive) setLoading(false);
      }
    };

    void load();
    const changed = () => void load();
    const focused = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("salon-data-changed", changed);
    window.addEventListener("focus", focused);
    const interval = poll ? setInterval(focused, 5000) : undefined;

    return () => {
      alive = false;
      window.removeEventListener("salon-data-changed", changed);
      window.removeEventListener("focus", focused);
      if (interval) clearInterval(interval);
    };
  }, [path, version, poll]);

  return { data, error, loading, reload };
}
// MAX documents the deep-link payload on initDataUnsafe.start_param, and it may be an
// object rather than a plain string. Accept every shape we can safely read.
function readStartParam(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const bag = value as Record<string, unknown>;
    for (const key of ["value", "startParam", "start_param", "payload"]) {
      if (typeof bag[key] === "string") return bag[key] as string;
    }
  }
  return null;
}
const LAUNCH_PAYLOAD = /^[A-Za-z0-9_-]{1,512}$/;
interface AuthContextValue {
  me: Me | null;
  loading: boolean;
  error: string;
  demo: boolean;
  botName: string;
  storefrontThemesV2: boolean;
  login: (persona: string) => Promise<void>;
  logout: () => void;
  reload: () => Promise<void>;
  launchPath: string | null;
  clearLaunchPath: () => void;
}
const AuthContext = createContext<AuthContextValue>(null!);
declare global {
  interface Window {
    WebApp?: {
      initData: string;
      platform?: "ios" | "android" | "desktop" | "web" | string;
      // MAX delivers the ?startapp= payload here; the signed initData may not carry it.
      initDataUnsafe?: { start_param?: unknown };
      ready: () => void;
      expand?: () => void;
      close?: () => void;
      BackButton?: {
        show: () => void;
        hide: () => void;
        onClick: (cb: () => void) => void;
        offClick: (cb: () => void) => void;
      };
    };
  }
}
export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [demo, setDemo] = useState(false),
    [botName, setBotName] = useState(""),
    [storefrontThemesV2, setStorefrontThemesV2] = useState(false),
    [launchPath, setLaunchPath] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (session) setMe(await api<Me>("/me"));
  }, []);
  const exchange = async (initData: string, fallbackPayload?: string | null) => {
    const auth = await api<{
      sessionToken: string;
      launchContext: string | null;
    }>("/auth/max", "POST", { initData });
    setSession(auth.sessionToken);
    await reload();
    // The signed initData is preferred, but MAX may only expose the payload unsigned.
    // /launch/resolve re-checks rights for every target, so an unsigned hint grants nothing.
    const payload = auth.launchContext ?? fallbackPayload ?? null;
    if (payload && LAUNCH_PAYLOAD.test(payload)) {
      try {
        const target = await api<{ path: string }>("/launch/resolve", "POST", {
          payload,
        });
        setLaunchPath(target.path);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Ссылка недоступна");
      }
    }
  };
  useEffect(() => {
    onUnauthorized = () => {
      setSession("");
      setMe(null);
      setError("Сессия истекла. Откройте приложение заново в MAX.");
    };
    let active = true;
    void (async () => {
      try {
        // One failed /config used to leave the app on a dead-end screen with no way
        // back: no persona list in demo, and "Откройте приложение в MAX" in production.
        let cfg:
          | {
              demo: boolean;
              botName: string;
              storefrontThemesV2: boolean;
            }
          | undefined;
        for (let attempt = 0; attempt < 3 && active; attempt++) {
          try {
            cfg = await api<{
              demo: boolean;
              botName: string;
              storefrontThemesV2: boolean;
            }>("/config");
            break;
          } catch (cause) {
            if (attempt === 2) throw cause;
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          }
        }
        if (!active || !cfg) return;
        setDemo(cfg.demo);
        setBotName(cfg.botName);
        setStorefrontThemesV2(cfg.storefrontThemesV2);
        await new Promise((r) => setTimeout(r, 150));
        const params = new URLSearchParams(window.location.hash.slice(1));
        const query = new URLSearchParams(window.location.search);
        const raw =
          window.WebApp?.initData ||
          params.get("WebAppData") ||
          query.get("WebAppData");
        const startParam =
          readStartParam(window.WebApp?.initDataUnsafe?.start_param) ??
          params.get("start_param") ??
          params.get("startapp") ??
          query.get("start_param") ??
          query.get("startapp");
        if (raw) {
          await exchange(raw, startParam);
          window.history.replaceState({}, "", window.location.pathname);
          window.WebApp?.ready();
          window.WebApp?.expand?.();
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Ошибка входа");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  const login = async (persona: string) => {
    setError("");
    setLoading(true);
    try {
      const { initData } = await api<{ initData: string }>(
        "/demo/identity",
        "POST",
        { persona },
      );
      await exchange(initData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setLoading(false);
    }
  };
  const logout = () => {
    void api("/auth/logout", "POST", {}).catch(() => {});
    setSession("");
    setMe(null);
    setError("");
  };
  return (
    <AuthContext.Provider
      value={{
        me,
        loading,
        error,
        demo,
        botName,
        storefrontThemesV2,
        login,
        logout,
        reload,
        launchPath,
        clearLaunchPath: () => setLaunchPath(null),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
export const useAuth = () => useContext(AuthContext);
