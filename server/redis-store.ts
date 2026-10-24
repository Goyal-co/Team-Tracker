import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import { HttpError } from "./errors";
import type { SessionRecord, TokenRecord } from "./store";

const SESSION = "mops:session:";
const USER_SESSIONS = "mops:user-sessions:";
const TOKEN = "mops:google:";
const LOCK = "mops:write-lock";

export interface SessionStore {
  get(tokenHash: string): Promise<SessionRecord | null> | SessionRecord | null;
  put(record: SessionRecord): Promise<void> | void;
  delete(tokenHash: string): Promise<void> | void;
  listByUser(userId: string): Promise<SessionRecord[]> | SessionRecord[];
}

export interface TokenStore {
  get(userId: string): Promise<TokenRecord | null> | TokenRecord | null;
  put(record: TokenRecord): Promise<void> | void;
  delete(userId: string): Promise<void> | void;
}

export function createRedisSessions(redis: Redis): SessionStore {
  return {
    async get(tokenHash) {
      const raw = await redis.get(SESSION + tokenHash);
      return raw ? (JSON.parse(raw) as SessionRecord) : null;
    },
    async put(record) {
      const ttl = Math.max(1, Math.ceil((Date.parse(record.expiresAt) - Date.now()) / 1000));
      await redis.set(SESSION + record.tokenHash, JSON.stringify(record), "EX", ttl);
      await redis.sadd(USER_SESSIONS + record.userId, record.tokenHash);
      await redis.expire(USER_SESSIONS + record.userId, 8 * 24 * 60 * 60);
    },
    async delete(tokenHash) {
      const current = await redis.get(SESSION + tokenHash);
      await redis.del(SESSION + tokenHash);
      if (!current) return;
      const record = JSON.parse(current) as SessionRecord;
      await redis.srem(USER_SESSIONS + record.userId, tokenHash);
    },
    async listByUser(userId) {
      const hashes = await redis.smembers(USER_SESSIONS + userId);
      const records: SessionRecord[] = [];
      for (const hash of hashes) {
        const raw = await redis.get(SESSION + hash);
        if (!raw) {
          await redis.srem(USER_SESSIONS + userId, hash);
          continue;
        }
        const record = JSON.parse(raw) as SessionRecord;
        if (record.expiresAt <= new Date().toISOString()) {
          await redis.del(SESSION + hash);
          await redis.srem(USER_SESSIONS + userId, hash);
          continue;
        }
        records.push(record);
      }
      return records;
    },
  };
}

export function createRedisTokens(redis: Redis): TokenStore {
  return {
    async get(userId) {
      const raw = await redis.get(TOKEN + userId);
      return raw ? (JSON.parse(raw) as TokenRecord) : null;
    },
    async put(record) {
      await redis.set(TOKEN + record.userId, JSON.stringify(record));
    },
    async delete(userId) {
      await redis.del(TOKEN + userId);
    },
  };
}

export function createRedisLock(redis: Redis) {
  return async function lock<T>(fn: () => Promise<T>): Promise<T> {
    const token = randomBytes(12).toString("hex");
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const acquired = await redis.set(LOCK, token, "PX", 15000, "NX");
      if (acquired === "OK") {
        try {
          return await fn();
        } finally {
          await redis.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            LOCK,
            token,
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new HttpError(503, "The workspace is busy. Try again.");
  };
}

export function createRedisRateLimit(redis: Redis) {
  return async (key: string, bucket: "auth" | "api") => {
    const limit = bucket === "auth" ? 30 : 240;
    const windowSeconds = bucket === "auth" ? 600 : 60;
    const redisKey = `mops:rate:${bucket}:${key}`;
    const count = await redis.incr(redisKey);
    if (count === 1) await redis.expire(redisKey, windowSeconds);
    return count <= limit;
  };
}
