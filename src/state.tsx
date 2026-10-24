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
  availability: (input: unknown) => Promise<{ people: AvailabilityPerson[]; warning: string; live: boolean }>;
  slots: (input: unknown) => Promise<{ slots: Array<{ start: string; end: string; confirmed: boolean }>; warning: string; confirmed: boolean }>;
  saveUser: (input: unknown, id?: string) => Promise<User>;
  saveProfileName: (name: string) => Promise<User>;
  createTeam: (input: { Name: string; Description: string }) => Promise<Team>;
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

  const watching = data?.access === "workspace" ? data.me.User_ID : "";
  useEffect(() => {
    if (!watching) return;
    const pull = () => {
      void api<{ messages: WorkspaceMessage[] }>("/api/messages")
        .then((next) => {
          setData((current) => {
            if (!current) return current;
            const previous = current.messages ?? [];
            const same = previous.length === next.messages.length && previous[previous.length - 1]?.Message_ID === next.messages[next.messages.length - 1]?.Message_ID;
            return same ? current : { ...current, messages: next.messages };
          });
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(pull, 3000);
    return () => window.clearInterval(timer);
  }, [watching]);

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
        availability: (input) => api("/api/calendar/availability", { method: "POST", body: JSON.stringify(input) }),
        slots: (input) => api("/api/calendar/slots", { method: "POST", body: JSON.stringify(input) }),
        saveUser: (input, id) =>
          run(async () => (await api<{ user: User }>(id ? `/api/users/${id}` : "/api/users", { method: id ? "PATCH" : "POST", body: JSON.stringify(input) })).user),
        saveProfileName: (name) =>
          run(async () => (await api<{ user: User }>("/api/me", { method: "PATCH", body: JSON.stringify({ Name: name }) })).user),
        createTeam: (input) => run(async () => (await api<{ team: Team }>("/api/teams", { method: "POST", body: JSON.stringify(input) })).team),
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
      }
    : null;

  if (!value) return <>{children({ data, loading, error, unauthorized, retry: () => void refresh() })}</>;
  return <WorkspaceContext.Provider value={value}>{children({ data, loading, error, unauthorized, retry: () => void refresh() })}</WorkspaceContext.Provider>;
}
