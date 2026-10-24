import { createServer } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companyFixture } from "../src/domain/fixture";
import type { BusinessDb } from "../src/domain/types";
import { createApp } from "./app";
import type { AppConfig } from "./config";

const NOW = new Date("2026-10-21T06:30:00.000Z");

function memoryStore(initial: BusinessDb) {
  let db = structuredClone(initial);
  return {
    kind: "file" as const,
    async read() {
      return structuredClone(db);
    },
    async write(next: BusinessDb) {
      db = structuredClone(next);
    },
  };
}

const config: AppConfig = {
  production: false,
  sessionSecret: "test-session-secret-value",
  bootstrapAdminEmail: "ada@example.com",
  googleClientId: "",
  googleClientSecret: "",
  googleRedirectUri: "http://localhost/callback",
  databaseUrl: "",
  redisUrl: "",
  port: 0,
  dataDir: "data",
  cookieSecure: false,
  trustProxy: false,
};

describe("http authorization", () => {
  const store = memoryStore(companyFixture(NOW));
  const sessions: { tokenHash: string; userId: string; expiresAt: string }[] = [];
  const tokens: { userId: string; refreshToken: string; accessToken: string; expiresAt: string }[] = [];
  const app = createApp({
    config,
    store,
    sessions: {
      get(tokenHash: string) {
        return sessions.find((item) => item.tokenHash === tokenHash && item.expiresAt > new Date().toISOString()) ?? null;
      },
      put(record: { tokenHash: string; userId: string; expiresAt: string }) {
        const index = sessions.findIndex((item) => item.tokenHash === record.tokenHash);
        if (index >= 0) sessions[index] = record;
        else sessions.push(record);
      },
      delete(tokenHash: string) {
        const index = sessions.findIndex((item) => item.tokenHash === tokenHash);
        if (index >= 0) sessions.splice(index, 1);
      },
      listByUser(userId: string) {
        return sessions.filter((item) => item.userId === userId && item.expiresAt > new Date().toISOString());
      },
    },
    tokens: {
      get(userId: string) {
        return tokens.find((item) => item.userId === userId) ?? null;
      },
      put(record: { userId: string; refreshToken: string; accessToken: string; expiresAt: string; scopes?: string }) {
        const index = tokens.findIndex((item) => item.userId === record.userId);
        if (index >= 0) tokens[index] = record;
        else tokens.push(record);
      },
      delete(userId: string) {
        const index = tokens.findIndex((item) => item.userId === userId);
        if (index >= 0) tokens.splice(index, 1);
      },
    },
    uploadDir: "data/uploads",
  });
  let base = "";
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  function signIn(userId: string) {
    const token = `session-${userId}`;
    sessions.push({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId,
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    return `mops_session=${encodeURIComponent(token)}`;
  }

  it("blocks an outsider and lets a team member rename only themselves", async () => {
    const outsider = signIn("U-005");
    const denied = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", Cookie: outsider },
      body: JSON.stringify({ Task_Title: "Should fail" }),
    });
    expect(denied.status).toBe(403);
    const waiting = await fetch(`${base}/api/bootstrap`, { headers: { Cookie: outsider } });
    expect(((await waiting.json()) as { access: string }).access).toBe("waiting");

    const member = signIn("U-003");
    const renamed = await fetch(`${base}/api/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", Cookie: member },
      body: JSON.stringify({ Name: "Mia Rao" }),
    });
    expect(renamed.status).toBe(200);
    const priority = await fetch(`${base}/api/tasks/T-0001`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", Cookie: member },
      body: JSON.stringify({ Updated_At: "2026-10-21T04:30:00.000Z", Priority: "Urgent" }),
    });
    expect(priority.status).toBe(403);

    const exported = await fetch(`${base}/api/export/work`, { headers: { Cookie: member } });
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("text/csv");
    const csv = await exported.text();
    expect(csv).toContain("TECH-1");
    expect(csv).not.toContain("MKT-1");
    const deniedExport = await fetch(`${base}/api/export/work`, { headers: { Cookie: outsider } });
    expect(deniedExport.status).toBe(403);
    const health = await fetch(`${base}/api/health`);
    expect(health.headers.get("x-frame-options")).toBe("DENY");
    expect(health.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});
