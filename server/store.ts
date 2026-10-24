import fs from "node:fs";
import path from "node:path";
import type { BusinessDb } from "../src/domain/types";
import { prepareDatabase, emptyWorkspace } from "../src/domain/workspace";

export interface DataStore {
  kind: "file" | "postgres";
  read(): Promise<BusinessDb>;
  write(db: BusinessDb): Promise<void>;
}

function writeAtomic(file: string, contents: string) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, contents);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.renameSync(temporary, file);
  } catch {
    fs.copyFileSync(temporary, file);
    fs.unlinkSync(temporary);
  }
}

export function readJsonFile<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    throw new Error(`Could not read ${path.basename(file)}. The file was left unchanged.`);
  }
}

export function writeJsonFile(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(value, null, 2));
}

export function createFileStore(file: string): DataStore {
  let cache: { mtimeMs: number; db: BusinessDb } | null = null;
  const remember = (db: BusinessDb) => {
    cache = { mtimeMs: fs.statSync(file).mtimeMs, db: structuredClone(db) };
  };
  return {
    kind: "file",
    async read() {
      if (!fs.existsSync(file)) {
        const empty = emptyWorkspace();
        writeJsonFile(file, empty);
        remember(empty);
        return structuredClone(empty);
      }
      const mtimeMs = fs.statSync(file).mtimeMs;
      if (cache && cache.mtimeMs === mtimeMs) return structuredClone(cache.db);
      const parsed = readJsonFile<unknown>(file, null);
      const prepared = prepareDatabase(parsed);
      if (prepared.persist) writeJsonFile(file, prepared.db);
      remember(prepared.db);
      return structuredClone(prepared.db);
    },
    async write(db) {
      writeJsonFile(file, db);
      remember(db);
    },
  };
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  expiresAt: string;
}

export interface TokenRecord {
  userId: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: string;
  scopes?: string;
}

export function createListStore<T>(file: string) {
  return {
    read(): T[] {
      return readJsonFile<T[]>(file, []);
    },
    write(value: T[]) {
      writeJsonFile(file, value);
    },
  };
}
