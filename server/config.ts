import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface AppConfig {
  production: boolean;
  sessionSecret: string;
  bootstrapAdminEmail: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  databaseUrl: string;
  redisUrl: string;
  port: number;
  dataDir: string;
  cookieSecure: boolean;
  trustProxy: boolean;
}

export function loadConfig(): AppConfig {
  const production = process.env.NODE_ENV === "production";
  const sessionSecret = process.env.SESSION_SECRET || (production ? "" : "dev-only-secret-change-me");
  if (!sessionSecret || sessionSecret.length < 16) {
    throw new Error("Set SESSION_SECRET to a random string of at least 16 characters.");
  }
  const bootstrapAdminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() ?? "";
  if (production && !bootstrapAdminEmail) {
    throw new Error("Set BOOTSTRAP_ADMIN_EMAIL to the Google account that should become the first administrator.");
  }
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  const redisUrl = process.env.REDIS_URL?.trim() ?? "";
  if (!databaseUrl || !redisUrl) {
    throw new Error("Set DATABASE_URL and REDIS_URL. From Team-Tracker, run: docker compose up -d");
  }
  return {
    production,
    sessionSecret,
    bootstrapAdminEmail,
    googleClientId: process.env.GOOGLE_CLIENT_ID?.trim() ?? "",
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "",
    googleRedirectUri: process.env.GOOGLE_REDIRECT_URI?.trim() || "https://localhost:5174/api/google/calendar/callback",
    databaseUrl,
    redisUrl,
    port: Number(process.env.PORT || 5175),
    dataDir: process.env.DATA_DIR || path.join(root, "data"),
    cookieSecure: process.env.COOKIE_SECURE === "true",
    trustProxy: process.env.TRUST_PROXY === "true",
  };
}

export function systemInfo(config: AppConfig, dataStore: "file" | "postgres") {
  return {
    googleClientId: config.googleClientId,
    calendarOAuthReady: Boolean(config.googleClientId && config.googleClientSecret && config.googleRedirectUri),
    dataStore,
    bootstrapConfigured: Boolean(config.bootstrapAdminEmail),
  };
}
