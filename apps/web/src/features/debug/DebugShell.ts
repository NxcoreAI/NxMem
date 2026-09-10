export function debugShellTitle() {
  return "Context Debug Shell";
}

export function isDebugShellEnabled(options?: { dev?: boolean }) {
  if (options?.dev) return true;
  if (import.meta.env.DEV) return true;
  return new URLSearchParams(window.location.search).has("debug") || localStorage.getItem("context-debug-shell") === "1";
}

export function enableDebugShell() {
  localStorage.setItem("context-debug-shell", "1");
}

export function disableDebugShell() {
  localStorage.removeItem("context-debug-shell");
}
