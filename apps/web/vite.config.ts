import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backendTarget = loadBackendTarget();

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/context": {
        target: backendTarget,
        changeOrigin: true
      },
      "/health": {
        target: backendTarget,
        changeOrigin: true
      }
    }
  }
});

function loadBackendTarget() {
  const config = loadProjectConfig();
  const host = readString(config.server?.host, "127.0.0.1");
  const port = readInteger(process.env.PORT, readInteger(config.server?.port, 3001));
  return `http://${host}:${port}`;
}

function loadProjectConfig() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const configPath = process.env.CONTEXT_ENGINE_CONFIG
    ? resolve(process.env.CONTEXT_ENGINE_CONFIG)
    : resolve(root, "config/context-engine.json");
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, "utf8")) as {
    server?: {
      host?: unknown;
      port?: unknown;
    };
  };
}

function readString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readInteger(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}
