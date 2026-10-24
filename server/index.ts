import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import pg from "pg";
import { loadConfig } from "./config";
import { createApp } from "./app";
import { prepareDatabase } from "../src/domain/workspace";
import { createPgLock, createPgRateLimit, createPgSessions, createPgTokens, createPgVersions, createPostgresStore, createRedisVersions, ensureWorkspaceSchema, workspaceIsEmpty } from "./postgres";
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

async function main() {
  loadEnvFile();
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  const pool = createPool(config.databaseUrl);
  await pool.query("SELECT 1");
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
  const store = createPostgresStore(pool, redisReady && redis ? createRedisVersions(redis) : createPgVersions(pool));
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
    lock: redisReady && redis ? createRedisLock(redis) : createPgLock(pool),
    allow: redisReady && redis ? createRedisRateLimit(redis) : createPgRateLimit(pool),
  });
  app.listen(config.port, () => {
    console.log(`Goyal Workspace API on http://localhost:${config.port} (postgres)`);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
