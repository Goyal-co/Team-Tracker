import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { formatDateTime, formatDay, formatTime, kolkataDayFromIso, kolkataToday } from "../domain/dates";
import { splitIds } from "../domain/ids";
import { unreadForPerson, unreadForTeam } from "../domain/inbox";
import type { Meeting, User, WorkspaceMessage } from "../domain/types";
import { cn, personAvatarSrc, teamAvatarSrc } from "../lib";
import { useWorkspace } from "../state";
import { useToast } from "../toast";
import { useShell } from "../components/shell";
import { Composer, MessageBody } from "../components/composer";
import { Avatar, Button, TextInput } from "../components/ui";

export function ChatPage() {
  const { data, sendMessage, sendDirectMessage, availability, createTeam, markRead } = useWorkspace();
  const shell = useShell();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [groupName, setGroupName] = useState("");
  const [makingGroup, setMakingGroup] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [presence, setPresence] = useState<Awaited<ReturnType<typeof availability>> | null>(null);
  const endRef = useRef<HTMLLIElement>(null);
  const threadPaneRef = useRef<HTMLElement>(null);
  const messageScrollerRef = useRef<HTMLDivElement>(null);
  const personId = params.get("with") ?? "";
  const groupId = personId ? "" : params.get("group") ?? "";
  const needle = query.trim().toLowerCase();
  const me = data.me.User_ID;
  const names = useMemo(() => new Map(data.users.map((user) => [user.User_ID, user.Name])), [data.users]);
  const messages = data.messages ?? [];
  const contacted = new Set<string>();
  const latest = new Map<string, string>();
  for (const message of messages) {
    if (!message.Recipient_ID) continue;
    const other = message.Author_ID === me ? message.Recipient_ID : message.Recipient_ID === me ? message.Author_ID : "";
    if (!other) continue;
    contacted.add(other);
    if ((latest.get(other) ?? "") < message.Created_At) latest.set(other, message.Created_At);
  }
  const directory = data.users.filter((user) => user.User_ID !== me && user.Status === "Active");
  const people = (needle
    ? directory.filter((user) => `${user.Name} ${user.Role} ${user.Department}`.toLowerCase().includes(needle))
    : directory.filter((user) => contacted.has(user.User_ID) || user.User_ID === personId)
  ).slice().sort((a, b) => (latest.get(b.User_ID) ?? "").localeCompare(latest.get(a.User_ID) ?? "") || a.Name.localeCompare(b.Name));
  const groups = data.teams.filter((team) => team.Status === "Active" && (!needle || team.Name.toLowerCase().includes(needle)));
  const thread = (personId
    ? messages.filter((message) => message.Recipient_ID && ((message.Author_ID === me && message.Recipient_ID === personId) || (message.Author_ID === personId && message.Recipient_ID === me)))
    : messages.filter((message) => message.Team_ID === groupId && !message.Recipient_ID)
  );
  const person = data.users.find((user) => user.User_ID === personId);
  const group = data.teams.find((team) => team.Team_ID === groupId);
  const profile = data.users.find((user) => user.User_ID === profileId) ?? null;
  const memberOf = new Set(data.members.filter((member) => member.User_ID === me && member.Status === "Active").map((member) => member.Team_ID));

  useEffect(() => {
    const scroller = messageScrollerRef.current;
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [thread.length, personId, groupId]);

  useEffect(() => {
    shell.setMobileChatOpen(Boolean(personId || groupId));
    return () => shell.setMobileChatOpen(false);
    // setMobileChatOpen is a stable React state setter from the shell
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId, groupId]);

  useEffect(() => {
    if (!personId && !groupId) return;
    const pane = threadPaneRef.current;
    if (!pane) return;
    const viewport = window.visualViewport;

    const sync = () => {
      if (window.matchMedia("(min-width: 768px)").matches) {
        pane.style.top = "";
        pane.style.height = "";
        pane.style.transform = "";
        return;
      }
      // Keep the chat chrome pinned to the screen top; only shrink height for the keyboard.
      // Do not use offsetTop — that scrolls the whole pane up and looks like a second header.
      const height = viewport?.height ?? window.innerHeight;
      pane.style.top = "0px";
      pane.style.height = `${Math.round(height)}px`;
      pane.style.transform = "";
    };

    sync();
    viewport?.addEventListener("resize", sync);
    window.addEventListener("resize", sync);
    return () => {
      viewport?.removeEventListener("resize", sync);
      window.removeEventListener("resize", sync);
      pane.style.top = "";
      pane.style.height = "";
      pane.style.transform = "";
    };
  }, [personId, groupId]);

  const openUnreadIds = useMemo(() => {
    const unread = personId
      ? unreadForPerson(data.notifications, personId)
      : groupId
        ? unreadForTeam(data.notifications, groupId)
        : [];
    return unread.map((item) => item.Notification_ID).sort().join(",");
  }, [personId, groupId, data.notifications]);

  useEffect(() => {
    if (!openUnreadIds) return;
    void markRead(openUnreadIds.split(",")).catch(() => undefined);
  }, [openUnreadIds]);

  useEffect(() => {
    if (!profileId) return;
    let cancel = false;
    const today = kolkataToday();
    void availability({ attendeeIds: [profileId], start: new Date(`${today}T09:30:00+05:30`).toISOString(), end: new Date(`${today}T18:30:00+05:30`).toISOString() })
      .then((result) => { if (!cancel) setPresence(result); })
      .catch(() => { if (!cancel) setPresence(null); });
    return () => { cancel = true; };
  }, [profileId]);

  function openGroup(id: string) {
    setProfileId(null);
    shell.setMobileChatOpen(true);
    setParams({ group: id });
  }

  function openPerson(id: string) {
    setProfileId(null);
    shell.setMobileChatOpen(true);
    setParams({ with: id });
  }

  async function send(body: string, file?: { File_Name: string; Mime_Type: string; Content_Base64: string }) {
    try {
      if (personId) await sendDirectMessage(personId, body, file);
      else await sendMessage(groupId, body, file);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not send that message.", "error");
      throw error;
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas md:flex-row">
      <aside className={`flex w-full shrink-0 flex-col border-line bg-white md:w-72 md:border-r ${personId || groupId ? "hidden md:flex" : "flex"}`}>
        <div className="border-b border-line p-3">
          <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search people" className="w-full" />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="flex items-center justify-between px-3 pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Groups</p>
            <button type="button" className="text-[12px] text-accent" onClick={() => setMakingGroup((open) => !open)}>New group</button>
          </div>
          {makingGroup && (
            <form className="flex gap-1 px-3 py-2" onSubmit={(event) => {
              event.preventDefault();
              void createTeam({ Name: groupName, Description: "" })
                .then((team) => { setGroupName(""); setMakingGroup(false); openGroup(team.Team_ID); toast("Group created. You are its lead."); })
                .catch((error: unknown) => toast(error instanceof Error ? error.message : "Could not create that group.", "error"));
            }}>
              <TextInput value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Group name" required className="w-full" />
              <Button type="submit">Create</Button>
            </form>
          )}
          <ul>
            {groups.length === 0 && <li className="px-3 py-2 text-[13px] text-muted">No groups match.</li>}
            {groups.map((team) => {
              const unread = unreadForTeam(data.notifications, team.Team_ID).length;
              return (
                <li key={team.Team_ID}>
                  <button type="button" className={`flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 ${groupId === team.Team_ID ? "bg-accent-soft" : ""}`} onClick={() => openGroup(team.Team_ID)}>
                    <Avatar name={team.Name} size={32} src={teamAvatarSrc(team)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{team.Name}</span>
                      <span className="block truncate text-[12px] text-muted">{memberOf.has(team.Team_ID) ? "You're in this group" : "Group chat"}</span>
                    </span>
                    {unread > 0 && <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">{unread > 9 ? "9+" : unread}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="px-3 pt-4 text-[11px] font-semibold uppercase tracking-wide text-muted">{needle ? "Search" : "Chats"}</p>
          <ul>
            {people.length === 0 && <li className="px-3 py-2 text-[13px] text-muted">{needle ? "No one matches that search." : "Search for a person to start a direct chat."}</li>}
            {people.map((user) => {
              const unread = unreadForPerson(data.notifications, user.User_ID).length;
              return (
                <li key={user.User_ID}>
                  <button type="button" className={`flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 ${personId === user.User_ID ? "bg-accent-soft" : ""}`} onClick={() => openPerson(user.User_ID)}>
                    <Avatar name={user.Name} size={32} src={personAvatarSrc(user)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{user.Name}</span>
                      <span className="block truncate text-[12px] text-muted">{preview(messages, me, user.User_ID) || user.Role || "Direct chat"}</span>
                    </span>
                    {unread > 0 && <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">{unread > 9 ? "9+" : unread}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
      <section
        ref={threadPaneRef}
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-canvas",
          personId || groupId
            ? profile
              ? "hidden md:flex"
              : "fixed inset-x-0 top-0 z-50 flex h-[100dvh] max-h-[100dvh] md:static md:inset-auto md:z-auto md:h-auto md:max-h-none"
            : "hidden md:flex",
        )}
      >
        <header className="z-10 flex shrink-0 items-center gap-1 border-b border-line bg-white px-1.5 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:gap-2 sm:px-3">
          {(personId || groupId) && (
            <button
              type="button"
              aria-label="Back to chats"
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink hover:bg-slate-100 md:hidden"
              onClick={() => { setProfileId(null); setParams({}); shell.setMobileChatOpen(false); }}
            >
              <ArrowLeft size={20} strokeWidth={2.25} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            {person ? (
              <button type="button" className="flex min-w-0 items-center gap-2.5 text-left" onClick={() => setProfileId(person.User_ID)}>
                <Avatar name={person.Name} size={36} src={personAvatarSrc(person)} />
                <span className="min-w-0 truncate text-[15px] font-semibold leading-5">{person.Name}</span>
              </button>
            ) : group ? (
              <div className="flex min-w-0 items-center gap-2.5">
                <Avatar name={group.Name} size={36} src={teamAvatarSrc(group)} />
                <span className="min-w-0 truncate text-[15px] font-semibold leading-5">{group.Name}</span>
              </div>
            ) : (
              <h1 className="text-[15px] font-semibold">Chat</h1>
            )}
          </div>
        </header>
        <div ref={messageScrollerRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <ul className="flex min-h-full flex-col justify-end gap-3 px-3 py-3 sm:px-4">
            {!personId && !groupId && <li className="text-[13px] text-muted">Open a group, or search for someone you have not chatted with yet.</li>}
            {(personId || groupId) && thread.length === 0 && <li className="text-[13px] text-muted">No messages yet.</li>}
            {thread.map((message) => {
              const mine = message.Author_ID === me;
              const authorUser = data.users.find((user) => user.User_ID === message.Author_ID);
              const author = authorUser?.Name ?? names.get(message.Author_ID) ?? "Someone";
              return (
                <li key={message.Message_ID} className={cn("flex items-end gap-2", mine && "flex-row-reverse")}>
                  {!mine && (
                    <button type="button" className="shrink-0" aria-label={`Open ${author}`} onClick={() => setProfileId(message.Author_ID)}>
                      <Avatar name={author} size={28} src={personAvatarSrc(authorUser)} />
                    </button>
                  )}
                  <div className={cn("flex min-w-0 max-w-[min(28rem,80vw)] flex-col", mine ? "items-end" : "items-start")}>
                    <button type="button" className="mb-0.5 text-[11px] leading-4 text-muted" onClick={() => setProfileId(message.Author_ID)}>
                      {author} · {formatDateTime(message.Created_At)}
                    </button>
                    <MessageBody message={message} mine={mine} users={data.users} onMention={setProfileId} />
                  </div>
                </li>
              );
            })}
            <li ref={endRef} aria-hidden className="h-0 overflow-hidden" />
          </ul>
        </div>
        <div className="shrink-0 border-t border-line bg-white pb-[env(safe-area-inset-bottom)]">
          <Composer
            key={personId || groupId || "none"}
            placeholder={person ? `Message ${person.Name}` : group ? `Message ${group.Name}` : "Choose a conversation"}
            disabled={!personId && !groupId}
            mentions={group ? data.users.filter((user) => user.User_ID !== me && user.Status === "Active" && data.members.some((member) => member.Team_ID === group.Team_ID && member.User_ID === user.User_ID && member.Status === "Active")) : []}
            onSend={send}
          />
        </div>
      </section>
      {profile && (
        <PersonPanel
          person={profile}
          presence={presence}
          onClose={() => setProfileId(null)}
          onMessage={() => {
            setProfileId(null);
            setParams({ with: profile.User_ID });
          }}
          onSchedule={() => shell.openCreateMeeting(kolkataToday(), [profile.User_ID])}
          onOpenTask={shell.openTask}
          onOpenMeeting={shell.openMeeting}
        />
      )}
    </div>
  );
}

function preview(messages: WorkspaceMessage[], me: string, userId: string) {
  const found = [...messages].reverse().find((message) => message.Recipient_ID && ((message.Author_ID === me && message.Recipient_ID === userId) || (message.Author_ID === userId && message.Recipient_ID === me)));
  return found?.Body || found?.File_Name || "";
}

function PersonPanel({
  person,
  presence,
  onClose,
  onMessage,
  onSchedule,
  onOpenTask,
  onOpenMeeting,
}: {
  person: User;
  presence: Awaited<ReturnType<ReturnType<typeof useWorkspace>["availability"]>> | null;
  onClose: () => void;
  onMessage: () => void;
  onSchedule: () => void;
  onOpenTask: (id: string) => void;
  onOpenMeeting: (id: string) => void;
}) {
  const { data } = useWorkspace();
  const today = kolkataToday();
  const groups = data.teams.filter((team) => team.Status === "Active" && data.members.some((member) => member.Team_ID === team.Team_ID && member.User_ID === person.User_ID && member.Status === "Active"));
  const tasks = data.tasks.filter((task) => task.Assigned_To === person.User_ID && task.Status !== "Completed").slice(0, 6);
  const meetings = data.meetings
    .filter((meeting) => meeting.Status === "Scheduled" && kolkataDayFromIso(meeting.Start_DateTime) >= today && attends(meeting, person.User_ID))
    .sort((a, b) => a.Start_DateTime.localeCompare(b.Start_DateTime))
    .slice(0, 6);
  const day = presence?.people[0];
  return (
    <aside className="fixed inset-0 z-50 flex w-full min-w-0 shrink-0 flex-col border-line bg-white md:static md:z-auto md:w-72 md:border-l">
      <div className="flex items-center gap-3 border-b border-line px-3 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button type="button" aria-label="Back to chat" className="inline-flex h-10 w-10 items-center justify-center rounded-full text-ink hover:bg-slate-100 md:hidden" onClick={onClose}>
          <ArrowLeft size={20} strokeWidth={2.25} />
        </button>
        <Avatar name={person.Name} size={40} src={personAvatarSrc(person)} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold">{person.Name}</h2>
          <p className="text-[12px] text-muted">{person.Role || person.Access_Role} · {person.Department || "No department"}</p>
          <p className="text-[12px] text-muted">{day ? `Today: ${day.state}` : "Checking today's calendar…"}</p>
        </div>
        <button type="button" className="hidden text-[12px] text-muted md:inline" onClick={onClose}>Close</button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto px-3 py-3">
        <div className="flex gap-2">
          <Button type="button" onClick={onMessage}>Message</Button>
          <Button type="button" variant="secondary" onClick={onSchedule}>Schedule</Button>
        </div>
        <section>
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Groups</h3>
          <p className="mt-1 text-[13px]">{groups.map((team) => team.Name).join(", ") || "Not in a shared group."}</p>
        </section>
        <section>
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Calendar</h3>
          {meetings.length === 0 && <p className="mt-1 text-[13px] text-muted">No upcoming meetings you can see.</p>}
          <ul className="mt-1 space-y-1">
            {meetings.map((meeting) => (
              <li key={meeting.Meeting_ID}>
                <button type="button" className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-slate-50" onClick={() => onOpenMeeting(meeting.Meeting_ID)}>
                  <span className="block text-[13px] font-medium">{meeting.Meeting_Title}</span>
                  <span className="text-[12px] text-muted">{formatDay(kolkataDayFromIso(meeting.Start_DateTime))} · {formatTime(meeting.Start_DateTime)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Open work</h3>
          {tasks.length === 0 && <p className="mt-1 text-[13px] text-muted">No open work assigned to them that you can see.</p>}
          <ul className="mt-1 space-y-1">
            {tasks.map((task) => (
              <li key={task.Task_ID}>
                <button type="button" className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-slate-50" onClick={() => onOpenTask(task.Task_ID)}>
                  <span className="block text-[13px] font-medium">{task.Task_Title}</span>
                  <span className="text-[12px] text-muted">{task.Key || task.Task_ID} · {task.Status} · due {formatDay(task.Due_Date)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </aside>
  );
}

function attends(meeting: Meeting, userId: string) {
  return meeting.Organized_By === userId || splitIds(meeting.Attendees).includes(userId);
}
