import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemeMode = "system" | "light" | "dark";
const STORAGE_KEY = "ryadom-color-mode";
type ThemeContextValue = { mode: ThemeMode; resolvedMode: "light" | "dark"; setMode: (mode: ThemeMode) => void };
const ThemeContext = createContext<ThemeContextValue | null>(null);

function readMode(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark") return value;
    const legacy = localStorage.getItem("ryadom-theme");
    return legacy === "light" || legacy === "dark" ? legacy : "system";
  } catch {
    return "system";
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const update = () => setSystemDark(media.matches);
    if (media.addEventListener) media.addEventListener("change", update);
    else media.addListener(update);
    return () => {
      if (media.removeEventListener) media.removeEventListener("change", update);
      else media.removeListener(update);
    };
  }, []);

  const resolved = mode === "system" ? (systemDark ? "dark" : "light") : mode;
  useEffect(() => {
    document.documentElement.dataset.colorMode = resolved;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = resolved === "dark" ? "#17161b" : "#f7f7fa";
  }, [resolved]);

  useEffect(() => {
    const syncTabs = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      const value = event.newValue;
      setModeState(value === "light" || value === "dark" ? value : "system");
    };
    window.addEventListener("storage", syncTabs);
    return () => window.removeEventListener("storage", syncTabs);
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The chosen mode still applies for this session when storage is unavailable.
    }
  }, []);
  const value = useMemo(() => ({ mode, resolvedMode: resolved, setMode }), [mode, resolved, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useColorMode() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useColorMode must be used inside ThemeProvider");
  return value;
}

export function ThemeModePicker({ compact = false }: { compact?: boolean }) {
  const { mode, setMode } = useColorMode();
  const options: Array<[ThemeMode, string]> = [
    ["system", "Как в системе"],
    ["light", "Светлая"],
    ["dark", "Тёмная"],
  ];
  return (
    <fieldset className={`theme-mode-picker ${compact ? "compact" : ""}`}>
      <legend>{compact ? "Тема" : "Тема приложения"}</legend>
      {!compact && <p>Автоматически учитываем тему устройства, если выбрано «Как в системе».</p>}
      <div className="theme-mode-options" role="group" aria-label="Цветовая тема приложения">
        {options.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
          >
            <svg className="theme-mode-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              {value === "system" ? (
                <>
                  <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.7" />
                  <path d="M12 3.5v17" stroke="currentColor" strokeWidth="1.7" />
                </>
              ) : value === "light" ? (
                <>
                  <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.7" />
                  <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                </>
              ) : (
                <path d="M19.4 15.4A8.2 8.2 0 0 1 8.6 4.6 8.5 8.5 0 1 0 19.4 15.4Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
            <span>{label}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}
