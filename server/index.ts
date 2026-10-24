import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import pg from "pg";
import { loadConfig } from "./config";
import { createApp } from "./app";
import { prepareDatabase } from "../src/domain/workspace";
import { createPostgresStore, ensureWorkspaceSchema, workspaceIsEmpty } from "./postgres";
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

async function main() {
  loadEnvFile();
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
  await pool.query("SELECT 1");
  await redis.ping();
  await ensureWorkspaceSchema(pool);
  const store = createPostgresStore(pool, redis);
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
  const sessions = createRedisSessions(redis);
  const tokens = createRedisTokens(redis);
  if (!(await redis.get("mops:legacy-imported"))) {
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
    lock: createRedisLock(redis),
    allow: createRedisRateLimit(redis),
  });
  app.listen(config.port, () => {
    console.log(`Goyal Workspace API on http://localhost:${config.port} (postgres)`);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
