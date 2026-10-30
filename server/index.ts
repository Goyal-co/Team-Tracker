import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import pg from "pg";
import { loadConfig } from "./config";
import { createApp } from "./app";
import { prepareDatabase } from "../src/domain/workspace";
import { createPgLock, createPgRateLimit, createPgSessions, createPgTokens, createPgVersions, createPostgresStore, createRedisVersions, ensureWorkspaceSchema, workspaceIsEmpty } from "./postgres";
import { createPushStore } from "./push";
import { createRedisLock, createRedisRateLimit, createRedisSessions, createRedisTokens } from "./redis-store";
import { readJsonFile, type SessionRecord, type TokenRecord } from "./store";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile() {
  const target = path.join(root, ".env");
  if (!fs.existsSync(target)) return;
  for (const line of fs.readFileSync(target, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function createPool(databaseUrl: string) {
  const local = /@(localhost|127\.0\.0\.1|postgres)(?::|\/)/.test(databaseUrl);
  if (local || !/[?&]sslmode=/.test(databaseUrl)) return new pg.Pool({ connectionString: databaseUrl });
  const url = new URL(databaseUrl);
  url.searchParams.delete("sslmode");
  return new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });
}

function quoteIdent(name: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("The database name in DATABASE_URL is not supported.");
  return `"${name}"`;
}

async function connectDatabase(databaseUrl: string) {
  const pool = createPool(databaseUrl);
  try {
    await pool.query("SELECT 1");
    return pool;
  } catch (error) {
    await pool.end().catch(() => undefined);
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    const message = error instanceof Error ? error.message : "";
    if (code !== "3D000" && !/does not exist/i.test(message)) throw error;
    const url = new URL(databaseUrl);
    const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!name || name === "postgres") throw error;
    url.pathname = "/postgres";
    const admin = createPool(url.toString());
    try {
      const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if ((existing.rowCount ?? 0) === 0) {
        await admin.query(`CREATE DATABASE ${quoteIdent(name)}`);
        console.log(`Created database ${name}.`);
      }
    } finally {
      await admin.end();
    }
    const created = createPool(databaseUrl);
    await created.query("SELECT 1");
    return created;
  }
}

async function main() {
  loadEnvFile();
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  const pool = await connectDatabase(config.databaseUrl);
  await ensureWorkspaceSchema(pool);
  const redis = config.redisUrl ? new Redis(config.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: true }) : null;
  redis?.on("error", () => undefined);
  let redisReady = false;
  if (redis) {
    try {
      await redis.connect();
      await redis.ping();
      redisReady = true;
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      console.error("Redis is not reachable. Sessions will be stored in PostgreSQL. Remove REDIS_URL on Render if you are not using Key Value.");
      redis.disconnect();
    }
  }
  const sessions = redisReady && redis ? createRedisSessions(redis) : createPgSessions(pool);
  const tokens = redisReady && redis ? createRedisTokens(redis) : createPgTokens(pool);
  const versions = redisReady && redis ? createRedisVersions(redis) : createPgVersions(pool);
  const store = createPostgresStore(pool, versions);
  const pushStore = createPushStore(pool);
  if (await workspaceIsEmpty(pool)) {
    const file = path.join(config.dataDir, "db.json");
    if (fs.existsSync(file)) {
      const prepared = prepareDatabase(readJsonFile<unknown>(file, null));
      await store.write(prepared.db);
      console.log("Imported the existing workspace file into PostgreSQL.");
    } else {
      const prepared = prepareDatabase({});
      await store.write(prepared.db);
    }
  }
  if (redisReady && redis && !(await redis.get("mops:legacy-imported"))) {
    for (const record of readJsonFile<SessionRecord[]>(path.join(config.dataDir, "sessions.json"), [])) {
      if (record.expiresAt > new Date().toISOString()) await sessions.put(record);
    }
    for (const record of readJsonFile<TokenRecord[]>(path.join(config.dataDir, "google-tokens.json"), [])) {
      await tokens.put(record);
    }
    await redis.set("mops:legacy-imported", "1");
  }
  const app = createApp({
    config,
    store,
    sessions,
    tokens,
    uploadDir: path.join(config.dataDir, "uploads"),
    versions,
    pushStore,
    lock: redisReady && redis ? createRedisLock(redis) : createPgLock(pool),
    allow: redisReady && redis ? createRedisRateLimit(redis) : createPgRateLimit(pool),
  });
  const server = app.listen(config.port, () => {
    console.log(`Goyal Workspace API on http://localhost:${config.port} (postgres)`);
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
