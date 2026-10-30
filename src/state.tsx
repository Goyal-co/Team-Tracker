import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";
import type { Bootstrap, Meeting, Task, Team, User, WorkspaceMessage } from "./domain/types";

interface AvailabilityPerson {
  userId: string;
  name: string;
  state: "available" | "busy" | "unknown";
  windows: Array<{ start: string; end: string; source: string }>;
}

interface WorkspaceValue {
  data: Bootstrap;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  createTask: (input: unknown) => Promise<Task>;
  updateTask: (id: string, input: unknown) => Promise<Task>;
  transitionTask: (id: string, input: unknown) => Promise<Task>;
  comment: (id: string, body: string) => Promise<void>;
  attach: (id: string, file: { File_Name: string; Mime_Type: string; Content_Base64: string }) => Promise<void>;
  bulk: (input: unknown) => Promise<void>;
  createMeeting: (input: unknown) => Promise<{ meeting: Meeting; calendarWarning: string }>;
  updateMeeting: (id: string, input: unknown) => Promise<Meeting>;
  cancelMeeting: (id: string, updatedAt: string) => Promise<void>;
  syncMeeting: (id: string) => Promise<void>;
  respondMeeting: (id: string, response: "accepted" | "declined" | "tentative") => Promise<void>;
  availability: (input: unknown) => Promise<{ people: AvailabilityPerson[]; warning: string; live: boolean }>;
  slots: (input: unknown) => Promise<{ slots: Array<{ start: string; end: string; confirmed: boolean }>; warning: string; confirmed: boolean }>;
  saveUser: (input: unknown, id?: string) => Promise<User>;
  saveProfileName: (name: string) => Promise<User>;
  createTeam: (input: { Name: string; Description: string }) => Promise<Team>;
  renameTeam: (teamId: string, name: string) => Promise<Team>;
  deleteTeam: (teamId: string) => Promise<void>;
  sendMessage: (teamId: string, body: string, file?: { File_Name: string; Mime_Type: string; Content_Base64: string }) => Promise<void>;
  sendDirectMessage: (recipientId: string, body: string, file?: { File_Name: string; Mime_Type: string; Content_Base64: string }) => Promise<void>;
  createProject: (input: { Team_ID: string; Name: string; Key: string }) => Promise<void>;
  addMember: (teamId: string, input: { User_ID: string; Member_Role: string }) => Promise<void>;
  invitePerson: (input: { Email: string; Team_ID: string; Access_Role: string; Member_Role: string }) => Promise<void>;
  revokeInvite: (id: string) => Promise<void>;
  respondInvite: (id: string, accept: boolean) => Promise<void>;
  markRead: (ids: string[] | "all") => Promise<void>;
  saveSettings: (input: unknown) => Promise<void>;
  disconnectCalendar: () => Promise<void>;
  enablePush: () => Promise<boolean>;
  disablePush: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("Workspace is not available.");
  return value;
}

export function WorkspaceGate({
  children,
}: {
  children: (state: { data: Bootstrap | null; loading: boolean; error: string; unauthorized: boolean; retry: () => void }) => ReactNode;
}) {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [unauthorized, setUnauthorized] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api<Bootstrap>("/api/bootstrap");
      setData(next);
      setError("");
      setUnauthorized(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUnauthorized(true);
        setData(null);
      } else {
        setError(err instanceof Error ? err.message : "Could not load the workspace.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const waiting = data?.access === "waiting" ? data.me.User_ID : "";
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => { void refresh(); }, 4000);
    return () => window.clearInterval(timer);
  }, [refresh, waiting]);

  const watching = data?.access === "workspace" ? data.me.User_ID : "";
  const syncVersion = data?.access === "workspace" ? (data.dbVersion || "0") : "";
  useEffect(() => {
    if (!watching) return;
    const pull = () => {
      void api<Bootstrap & { unchanged?: boolean }>(`/api/sync?v=${encodeURIComponent(syncVersion || "0")}`)
        .then((next) => {
          if (next.unchanged) return;
          setData((current) => {
            if (!current) return next;
            const incoming = Number(next.dbVersion || 0);
            const existing = Number(current.dbVersion || 0);
            if (Number.isFinite(incoming) && Number.isFinite(existing) && incoming < existing) return current;
            return next;
          });
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(pull, 2500);
    return () => window.clearInterval(timer);
  }, [watching, syncVersion]);

  function keepMessage(message: WorkspaceMessage) {
    setData((current) => {
      if (!current || (current.messages ?? []).some((item) => item.Message_ID === message.Message_ID)) return current;
      return { ...current, messages: [...(current.messages ?? []), message] };
    });
  }

  async function run<T>(fn: () => Promise<T>) {
    const result = await fn();
    await refresh();
    return result;
  }

  const value: WorkspaceValue | null = data
    ? {
        data,
        refresh,
        signOut: async () => {
          await api("/api/auth/logout", { method: "POST" });
          setData(null);
          setUnauthorized(true);
        },
        createTask: (input) => run(async () => (await api<{ task: Task }>("/api/tasks", { method: "POST", body: JSON.stringify(input) })).task),
        updateTask: (id, input) => run(async () => (await api<{ task: Task }>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(input) })).task),
        transitionTask: (id, input) =>
          run(async () => (await api<{ task: Task }>(`/api/tasks/${id}/transition`, { method: "POST", body: JSON.stringify(input) })).task),
        comment: (id, body) => run(() => api(`/api/tasks/${id}/comments`, { method: "POST", body: JSON.stringify({ Body: body }) })),
        attach: (id, file) => run(() => api(`/api/tasks/${id}/attachments`, { method: "POST", body: JSON.stringify(file) })),
        bulk: (input) => run(() => api("/api/tasks/bulk", { method: "POST", body: JSON.stringify(input) })),
        createMeeting: (input) => run(() => api("/api/meetings", { method: "POST", body: JSON.stringify(input) })),
        updateMeeting: (id, input) =>
          run(async () => (await api<{ meeting: Meeting }>(`/api/meetings/${id}`, { method: "PATCH", body: JSON.stringify(input) })).meeting),
        cancelMeeting: (id, updatedAt) => run(() => api(`/api/meetings/${id}/cancel`, { method: "POST", body: JSON.stringify({ Updated_At: updatedAt }) })),
        syncMeeting: (id) => run(() => api(`/api/meetings/${id}/sync`, { method: "POST" })),
        respondMeeting: (id, response) => run(() => api(`/api/meetings/${id}/respond`, { method: "POST", body: JSON.stringify({ response }) })),
        availability: (input) => api("/api/calendar/availability", { method: "POST", body: JSON.stringify(input) }),
        slots: (input) => api("/api/calendar/slots", { method: "POST", body: JSON.stringify(input) }),
        saveUser: (input, id) =>
          run(async () => (await api<{ user: User }>(id ? `/api/users/${id}` : "/api/users", { method: id ? "PATCH" : "POST", body: JSON.stringify(input) })).user),
        saveProfileName: (name) =>
          run(async () => (await api<{ user: User }>("/api/me", { method: "PATCH", body: JSON.stringify({ Name: name }) })).user),
        createTeam: (input) => run(async () => (await api<{ team: Team }>("/api/teams", { method: "POST", body: JSON.stringify(input) })).team),
        renameTeam: (teamId, name) => run(async () => (await api<{ team: Team }>(`/api/teams/${teamId}`, { method: "PATCH", body: JSON.stringify({ Name: name }) })).team),
        deleteTeam: (teamId) => run(() => api(`/api/teams/${teamId}`, { method: "DELETE" })),
        sendMessage: async (teamId, body, file) => {
          const sent = await api<{ message: WorkspaceMessage }>(`/api/teams/${teamId}/messages`, { method: "POST", body: JSON.stringify({ Body: body, ...file }) });
          keepMessage(sent.message);
          await refresh();
          keepMessage(sent.message);
        },
        sendDirectMessage: async (recipientId, body, file) => {
          const sent = await api<{ message: WorkspaceMessage }>("/api/messages", { method: "POST", body: JSON.stringify({ Recipient_ID: recipientId, Body: body, ...file }) });
          keepMessage(sent.message);
          await refresh();
          keepMessage(sent.message);
        },
        createProject: (input) => run(() => api("/api/projects", { method: "POST", body: JSON.stringify(input) })),
        addMember: (teamId, input) => run(() => api(`/api/teams/${teamId}/members`, { method: "POST", body: JSON.stringify(input) })),
        invitePerson: (input) => run(() => api("/api/invites", { method: "POST", body: JSON.stringify(input) })),
        revokeInvite: (id) => run(() => api(`/api/invites/${id}/revoke`, { method: "POST", body: "{}" })),
        respondInvite: (id, accept) => run(() => api(`/api/invites/${id}/respond`, { method: "POST", body: JSON.stringify({ accept }) })),
        saveSettings: (input) => run(() => api("/api/settings", { method: "PUT", body: JSON.stringify(input) })),
        markRead: (ids) => run(() => api("/api/notifications/read", { method: "POST", body: JSON.stringify(ids === "all" ? { all: true } : { ids }) })),
        disconnectCalendar: () => run(() => api("/api/google/calendar/disconnect", { method: "POST" })),
        enablePush: async () => {
          if (!data.pushReady || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return false;
          await navigator.serviceWorker.register("/sw.js").catch(() => undefined);
          const permission = await Notification.requestPermission();
          if (permission !== "granted") return false;
          const key = await api<{ publicKey: string; ready: boolean }>("/api/push/vapid-public-key");
          if (!key.ready || !key.publicKey) return false;
          const registration = await navigator.serviceWorker.ready;
          const applicationServerKey = urlBase64ToUint8Array(key.publicKey);
          const existing = await registration.pushManager.getSubscription();
          const sameKey = existing?.options.applicationServerKey
            && bufferToBase64Url(existing.options.applicationServerKey) === key.publicKey;
          if (existing && !sameKey) {
            await api("/api/push/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint: existing.endpoint }) }).catch(() => undefined);
            await existing.unsubscribe().catch(() => undefined);
          }
          const subscription = (existing && sameKey)
            ? existing
            : await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
          const json = subscription.toJSON();
          await api("/api/push/subscribe", {
            method: "POST",
            body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
          });
          window.localStorage.setItem("goyal-push", "on");
          return true;
        },
        disablePush: async () => {
          if ("serviceWorker" in navigator) {
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.getSubscription();
            if (subscription) {
              await api("/api/push/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint: subscription.endpoint }) }).catch(() => undefined);
              await subscription.unsubscribe().catch(() => undefined);
            }
          }
          window.localStorage.setItem("goyal-push", "off");
        },
      }
    : null;

  if (!value) return <>{children({ data, loading, error, unauthorized, retry: () => void refresh() })}</>;
  return <WorkspaceContext.Provider value={value}>{children({ data, loading, error, unauthorized, retry: () => void refresh() })}</WorkspaceContext.Provider>;
}

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

function bufferToBase64Url(value: ArrayBuffer | null) {
  if (!value) return "";
  const bytes = new Uint8Array(value);
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return window.btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
