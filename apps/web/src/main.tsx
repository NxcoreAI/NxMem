import React from "react";
import ReactDOM from "react-dom/client";
import { DebugApp } from "./app";
import { debugShellTitle, disableDebugShell, enableDebugShell, isDebugShellEnabled } from "./features/debug/DebugShell";

const root = document.getElementById("root");

if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ShellGate />
    </React.StrictMode>
  );
}

function ShellGate() {
  const [enabled, setEnabled] = React.useState(isDebugShellEnabled());

  React.useEffect(() => {
    const onStorage = () => setEnabled(isDebugShellEnabled());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  if (enabled) return <DebugApp />;

  if (import.meta.env.DEV) return <DebugApp />;

  return (
    <main style={{ padding: 24, fontFamily: "Inter, system-ui, sans-serif" }}>
      <h1>{debugShellTitle()}</h1>
      <p>调试壳已关闭。使用 `?debug=1` 或本地存储开关启用。</p>
      <button
        type="button"
        onClick={() => {
          enableDebugShell();
          setEnabled(true);
        }}
      >
        启用调试壳
      </button>
      <button
        type="button"
        onClick={() => {
          disableDebugShell();
          setEnabled(false);
        }}
        style={{ marginLeft: 8 }}
      >
        关闭调试壳
      </button>
    </main>
  );
}
