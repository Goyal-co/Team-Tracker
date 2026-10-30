import webpush from "web-push";
import type { Pool } from "pg";

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function loadPushConfig(): PushConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = process.env.VAPID_SUBJECT?.trim() || "mailto:admin@localhost";
  if (!publicKey || !privateKey) return null;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return { publicKey, privateKey, subject };
}

export function createPushStore(pool: Pool) {
  return {
    async save(userId: string, subscription: PushSubscriptionInput) {
      const endpoint = subscription.endpoint?.trim() ?? "";
      const p256dh = subscription.keys?.p256dh?.trim() ?? "";
      const auth = subscription.keys?.auth?.trim() ?? "";
      if (!endpoint || !p256dh || !auth) throw new Error("Invalid push subscription.");
      await pool.query(
        `INSERT INTO workspace.push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, created_at = EXCLUDED.created_at`,
        [endpoint, userId, p256dh, auth, new Date().toISOString()],
      );
    },
    async remove(endpoint: string, userId?: string) {
      if (userId) {
        await pool.query("DELETE FROM workspace.push_subscriptions WHERE endpoint = $1 AND user_id = $2", [endpoint, userId]);
      } else {
        await pool.query("DELETE FROM workspace.push_subscriptions WHERE endpoint = $1", [endpoint]);
      }
    },
    async removeAllForUser(userId: string) {
      await pool.query("DELETE FROM workspace.push_subscriptions WHERE user_id = $1", [userId]);
    },
    async listForUser(userId: string) {
      const result = await pool.query<{ endpoint: string; p256dh: string; auth: string }>(
        "SELECT endpoint, p256dh, auth FROM workspace.push_subscriptions WHERE user_id = $1",
        [userId],
      );
      return result.rows;
    },
  };
}

export type PushStore = ReturnType<typeof createPushStore>;

export function pushUrlFor(entityType: string, entityId: string) {
  if (entityType === "task") return `/?task=${encodeURIComponent(entityId)}`;
  if (entityType === "meeting") return `/calendar`;
  if (entityType === "team") return `/team`;
  if (entityType === "user") return `/chat?with=${encodeURIComponent(entityId)}`;
  return "/";
}

export async function sendPushToUser(
  store: PushStore,
  config: PushConfig | null,
  userId: string,
  title: string,
  body: string,
  entityType: string,
  entityId: string,
) {
  if (!config) return;
  const rows = await store.listForUser(userId);
  if (!rows.length) return;
  const payload = JSON.stringify({ title, body, url: pushUrlFor(entityType, entityId) });
  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          payload,
        );
      } catch (error) {
        const status = typeof error === "object" && error && "statusCode" in error ? Number((error as { statusCode: number }).statusCode) : 0;
        if (status === 404 || status === 410) await store.remove(row.endpoint);
      }
    }),
  );
}
