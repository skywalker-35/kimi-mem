import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "opencode-mem-theme";

function readTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return "dark";
}

let currentTheme: Theme = readTheme();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function applyTheme(theme: Theme) {
  currentTheme = theme;
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem(STORAGE_KEY, theme);
  }
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return currentTheme;
}

function getServerSnapshot(): Theme {
  return "dark";
}

export function getTheme(): Theme {
  return currentTheme;
}

export function setTheme(theme: Theme) {
  applyTheme(theme);
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

export function initTheme(): void {
  applyTheme(readTheme());
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// Apply on module load so first paint matches stored preference.
if (typeof document !== "undefined") {
  applyTheme(currentTheme);
}
