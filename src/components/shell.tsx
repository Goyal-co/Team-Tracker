import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useOutletContext } from "react-router-dom";
import { Bell, CalendarDays, CircleHelp, Download, History, LayoutDashboard, ListChecks, LogOut, Menu, MessageSquare, PanelLeft, Plus, Search, Settings, Users, X } from "lucide-react";
import { formatLongDate } from "../domain/dates";
import { canCreateTasks } from "../domain/permissions";
import { cn } from "../lib";
import { useWorkspace } from "../state";
import { useToast } from "../toast";
import { MeetingDrawer } from "./meeting-drawer";
import { TaskCreateDrawer } from "./task-create";
import { TaskDetailDrawer } from "./task-detail";
import { Avatar, Button } from "./ui";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/my-tasks", label: "My Work", icon: ListChecks },
  { to: "/calendar", label: "Calendar", icon: CalendarDays },
  { to: "/team", label: "Workspaces", icon: Users },
  { to: "/chat", label: "Chat", icon: MessageSquare },
  { to: "/activity", label: "Activity", icon: History },
];

export function Shell() {
  const { data, signOut, markRead, respondInvite } = useWorkspace();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobile, setMobile] = useState(false);
  const [expanded, setExpanded] = useState(() => window.localStorage.getItem("goyal-sidebar") !== "collapsed");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const [createTask, setCreateTask] = useState<string | null>(null);
  const [createMeeting, setCreateMeeting] = useState<{ date?: string; attendeeIds?: string[] } | null>(null);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(new URLSearchParams(location.search).get("task"));
  const [quick, setQuick] = useState(false);
  const quickRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLDivElement>(null);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPrompt | null>(null);
  const [installHelp, setInstallHelp] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const unread = data.notifications.filter((item) => !item.Read_At).length;
  const myInvites = data.invites.filter((invite) => invite.Status === "Pending" && invite.Email.toLowerCase() === data.me.Email.toLowerCase());

  useEffect(() => {
    setStandalone(window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true);
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPrompt);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  async function installApp() {
    if (!installEvent) {
      setInstallHelp(true);
      return;
    }
    await installEvent.prompt();
    setInstallEvent(null);
  }

  useEffect(() => {
    window.localStorage.setItem("goyal-sidebar", expanded ? "expanded" : "collapsed");
  }, [expanded]);

  useEffect(() => {
    setMobile(false);
    const next = new URLSearchParams(location.search).get("task");
    if (next) setTaskId(next);
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!quick && !notesOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (quick && !quickRef.current?.contains(target)) setQuick(false);
      if (notesOpen && !notesRef.current?.contains(target)) setNotesOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [notesOpen, quick]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return { tasks: [], people: [], meetings: [] };
    return {
      tasks: data.tasks.filter((task) => `${task.Key} ${task.Task_Title} ${task.Labels} ${task.Project}`.toLowerCase().includes(needle)).slice(0, 6),
      people: data.users.filter((user) => `${user.Name} ${user.Role}`.toLowerCase().includes(needle)).slice(0, 4),
      meetings: data.meetings.filter((meeting) => meeting.Meeting_Title.toLowerCase().includes(needle)).slice(0, 4),
    };
  }, [data.meetings, data.tasks, data.users, query]);

  const showLabels = expanded || mobile;
  const navItem = cn("flex w-full items-center rounded-lg", showLabels ? "flex-row flex-nowrap gap-3 px-3 py-2 text-left text-[13px]" : "flex-col gap-1 px-1.5 py-2 text-center text-[11px] leading-3");

  return (
    <div className="flex h-full min-h-screen bg-canvas">
      <aside className={cn("fixed inset-y-0 left-0 z-30 flex flex-col border-r border-line bg-white transition-[width] duration-200 md:static", showLabels ? "w-64" : "w-[72px]", mobile ? "translate-x-0" : "-translate-x-full md:translate-x-0")}>
        <div className={cn("flex h-14 shrink-0 flex-row flex-nowrap items-center", showLabels ? "gap-2 px-3" : "justify-center")}>
          {showLabels ? (
            <>
              <span className="flex min-w-0 flex-1 flex-row flex-nowrap items-center gap-2">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-sm font-semibold text-white">G</span>
                <span className="truncate whitespace-nowrap text-[13px] font-semibold leading-none">Goyal Workspace</span>
              </span>
              <button type="button" className="hidden shrink-0 rounded-lg p-1.5 text-muted hover:bg-slate-50 md:inline-flex" aria-label="Collapse sidebar" onClick={() => setExpanded(false)}>
                <PanelLeft size={18} />
              </button>
            </>
          ) : (
            <button type="button" className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-sm font-semibold text-white" aria-label="Expand sidebar" title="Expand sidebar" onClick={() => setExpanded(true)}>G</button>
          )}
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2" aria-label="Primary">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} title={item.label} className={({ isActive }) => cn(navItem, isActive ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-slate-50 hover:text-ink")}>
              <item.icon size={18} className="shrink-0" />
              {showLabels && <span className="truncate">{item.label}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="flex flex-col gap-0.5 border-t border-line px-2 py-2">
          <NavLink to="/settings" title="Settings" className={({ isActive }) => cn(navItem, isActive ? "bg-accent-soft text-accent" : "text-muted hover:bg-slate-50 hover:text-ink")}>
            <Settings size={18} className="shrink-0" />{showLabels && <span>Settings</span>}
          </NavLink>
          <NavLink to="/help" title="Help" className={({ isActive }) => cn(navItem, isActive ? "bg-accent-soft text-accent" : "text-muted hover:bg-slate-50 hover:text-ink")}>
            <CircleHelp size={18} className="shrink-0" />{showLabels && <span>Help</span>}
          </NavLink>
          {!standalone && (
            <button type="button" title="Add to Home Screen" className={cn(navItem, "text-muted hover:bg-slate-50 hover:text-ink")} onClick={() => void installApp()}>
              <Download size={18} className="shrink-0" />{showLabels && <span>Install</span>}
            </button>
          )}
          <button type="button" title={data.me.Name} aria-label="Your profile" className={cn(navItem, "text-ink hover:bg-slate-50")} onClick={() => navigate(`/team/${data.me.User_ID}`)}>
            <Avatar name={data.me.Name} size={28} />
            {showLabels && <span className="truncate">{data.me.Name}</span>}
          </button>
          <button type="button" title="Sign out" aria-label="Sign out" onClick={() => void signOut()} className={cn(navItem, "text-muted hover:bg-slate-50 hover:text-ink")}>
            <LogOut size={16} className="shrink-0" />{showLabels && <span>Sign out</span>}
          </button>
        </div>
      </aside>
      {mobile && <button className="fixed inset-0 z-20 bg-slate-900/30 md:hidden" aria-label="Close menu" onClick={() => setMobile(false)} />}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-end gap-3 border-b border-line bg-white px-3 md:gap-4 md:px-5">
          <button type="button" className="mr-auto rounded-lg p-2 text-muted hover:bg-slate-50 md:hidden" aria-label="Open menu" onClick={() => setMobile(true)}><Menu size={18} /></button>
          <button type="button" className="rounded-lg p-2 text-muted hover:bg-slate-50 md:hidden" aria-label="Search" onClick={() => setSearchOpen(true)}><Search size={18} /></button>
          <button type="button" className="hidden h-9 w-80 shrink-0 items-center gap-2 rounded-[10px] border border-line bg-canvas px-3 text-left text-[13px] text-muted md:flex" onClick={() => setSearchOpen(true)}>
            <Search size={15} />
            <span className="truncate">Search work, people, meetings</span>
            <span className="ml-auto hidden text-[11px] lg:inline">Ctrl K</span>
          </button>
          <span className="hidden text-[13px] text-muted lg:inline">{formatLongDate()}</span>
          <div className="relative" ref={quickRef}>
            <Button type="button" className="px-2 sm:px-3" onClick={() => { setNotesOpen(false); setQuick((value) => !value); }}><Plus size={15} /><span className="hidden sm:inline">Quick create</span></Button>
            {quick && (
              <div className="absolute right-0 z-20 mt-1 w-48 rounded-xl border border-line bg-white p-1 shadow-lg">
                {canCreateTasks(data.me, data.members) && <button type="button" className="block w-full rounded-lg px-3 py-2 text-left text-[13px] hover:bg-slate-50" onClick={() => { setQuick(false); setCreateTask(""); }}>Create work</button>}
                <button type="button" className="block w-full rounded-lg px-3 py-2 text-left text-[13px] hover:bg-slate-50" onClick={() => { setQuick(false); setCreateMeeting({}); }}>Schedule meeting</button>
              </div>
            )}
          </div>
          <div className="relative" ref={notesRef}>
            <button type="button" className="relative rounded-lg p-2 text-muted hover:bg-slate-50" aria-label="Notifications" onClick={() => { setQuick(false); setNotesOpen((value) => !value); }}>
              <Bell size={18} />
              {unread > 0 && <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[9px] font-semibold leading-none text-white">{unread > 9 ? "9+" : unread}</span>}
            </button>
            {notesOpen && (
              <div className="absolute right-0 z-20 mt-1 w-[min(20rem,calc(100vw-1.5rem))] rounded-xl border border-line bg-white shadow-lg">
                <div className="flex items-center justify-between border-b border-line px-3 py-2">
                  <span className="text-[13px] font-semibold">Notifications</span>
                  <button type="button" className="text-[12px] text-accent" onClick={() => void markRead("all").catch((error: Error) => toast(error.message, "error"))}>Mark all read</button>
                </div>
                <ul className="max-h-80 overflow-auto">
                  {data.notifications.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted">You are up to date.</li>}
                  {data.notifications.slice(0, 12).map((item) => (
                    <li key={item.Notification_ID}>
                      <button
                        type="button"
                        className={cn("block w-full px-3 py-2 text-left hover:bg-slate-50", !item.Read_At && "bg-accent-soft/60")}
                        onClick={() => {
                          void markRead([item.Notification_ID]);
                          setNotesOpen(false);
                          if (item.Entity_Type === "task") setTaskId(item.Entity_ID);
                          if (item.Entity_Type === "meeting") setMeetingId(item.Entity_ID);
                          if (item.Entity_Type === "user") navigate(`/chat?with=${item.Entity_ID}`);
                          if (item.Entity_Type === "team") navigate(`/chat?group=${item.Entity_ID}`);
                        }}
                      >
                        <span className="block text-[13px] font-medium">{item.Title}</span>
                        <span className="block text-[12px] text-muted">{item.Body}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <button type="button" aria-label="Your profile" className="ml-1" onClick={() => navigate(`/team/${data.me.User_ID}`)}><Avatar name={data.me.Name} size={32} /></button>
        </header>
        {myInvites.length > 0 && (
          <div className="border-b border-line bg-accent-soft px-3 py-2 md:px-5">
            {myInvites.map((invite) => {
              const team = data.teams.find((item) => item.Team_ID === invite.Team_ID);
              return (
                <div key={invite.Invite_ID} className="flex flex-wrap items-center gap-2 py-1 text-[13px]">
                  <span className="font-medium">Invitation request</span>
                  <span className="text-muted">{team?.Name || "A group"} · {invite.Member_Role}</span>
                  <Button type="button" className="h-7 px-2" onClick={() => void respondInvite(invite.Invite_ID, true).then(() => toast("You joined the group.")).catch((error: Error) => toast(error.message, "error"))}>Accept</Button>
                  <Button type="button" variant="secondary" className="h-7 px-2" onClick={() => void respondInvite(invite.Invite_ID, false).then(() => toast("Invite declined.")).catch((error: Error) => toast(error.message, "error"))}>Decline</Button>
                </div>
              );
            })}
          </div>
        )}
        <main id="content" className={cn("flex min-h-0 min-w-0 flex-1 flex-col", location.pathname === "/chat" ? "overflow-hidden pb-16 md:pb-0" : "overflow-auto px-3 py-4 pb-24 md:px-4 md:pb-4")}>
          <Outlet context={{ openTask: setTaskId, openCreateTask: (teamId?: string) => setCreateTask(typeof teamId === "string" ? teamId : ""), openCreateMeeting: (date?: string, attendeeIds?: string[]) => setCreateMeeting({ date, attendeeIds }), openMeeting: setMeetingId }} />
        </main>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-white pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="Mobile">
        {NAV.filter((item) => item.to !== "/activity" && item.to !== "/calendar").map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => cn("flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 text-[10px]", isActive ? "font-medium text-accent" : "text-muted")}>
            <item.icon size={18} />
            <span className="truncate">{item.label}</span>
          </NavLink>
        ))}
      </nav>
      {installHelp && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/30 p-4 sm:items-center" onMouseDown={(event) => { if (event.target === event.currentTarget) setInstallHelp(false); }}>
          <div role="dialog" aria-modal="true" className="w-full max-w-sm rounded-xl border border-line bg-white p-5 shadow-xl">
            <h2 className="text-[16px] font-semibold">Add to Home Screen</h2>
            <p className="mt-2 text-[13px] leading-5 text-muted">On iPhone or iPad, open the Share menu and choose Add to Home Screen. On Android or desktop Chrome, open the browser menu and choose Install app.</p>
            <div className="mt-4 flex justify-end">
              <Button type="button" onClick={() => setInstallHelp(false)}>Close</Button>
            </div>
          </div>
        </div>
      )}
      {searchOpen && (
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-slate-900/30 px-4 pt-[12vh]" onMouseDown={(event) => { if (event.target === event.currentTarget) setSearchOpen(false); }}>
          <div className="w-full max-w-xl rounded-xl border border-line bg-white shadow-xl" role="dialog" aria-label="Search">
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Search size={16} className="text-muted" />
              <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === "Escape" && setSearchOpen(false)} placeholder="Search" className="h-11 flex-1 outline-none" />
              <button type="button" aria-label="Close search" onClick={() => setSearchOpen(false)}><X size={16} /></button>
            </div>
            <div className="max-h-80 overflow-auto p-2">
              {query && results && results.tasks.length + results.people.length + results.meetings.length === 0 && <p className="px-2 py-6 text-center text-[13px] text-muted">No matches.</p>}
              {results && results.tasks.map((task) => (
                <button key={task.Task_ID} type="button" className="block w-full rounded-lg px-2 py-2 text-left hover:bg-slate-50" onClick={() => { setSearchOpen(false); setTaskId(task.Task_ID); }}>
                  <span className="text-[13px] font-medium">{task.Task_Title}</span>
                  <span className="ml-2 text-[12px] text-muted">{task.Key || task.Task_ID}</span>
                </button>
              ))}
              {results && results.people.map((user) => (
                <button key={user.User_ID} type="button" className="block w-full rounded-lg px-2 py-2 text-left text-[13px] hover:bg-slate-50" onClick={() => { setSearchOpen(false); navigate(`/team/${user.User_ID}`); }}>{user.Name} · {user.Role}</button>
              ))}
              {results && results.meetings.map((meeting) => (
                <button key={meeting.Meeting_ID} type="button" className="block w-full rounded-lg px-2 py-2 text-left text-[13px] hover:bg-slate-50" onClick={() => { setSearchOpen(false); setMeetingId(meeting.Meeting_ID); }}>{meeting.Meeting_Title}</button>
              ))}
            </div>
          </div>
        </div>
      )}
      {createTask !== null && <TaskCreateDrawer initialTeamId={createTask} onClose={() => setCreateTask(null)} onCreated={(id) => { setCreateTask(null); setTaskId(id); }} />}
      {taskId && <TaskDetailDrawer key={taskId} taskId={taskId} onClose={() => setTaskId(null)} />}
      {(createMeeting || meetingId) && (
        <MeetingDrawer
          key={meetingId || createMeeting?.date || "new-meeting"}
          meetingId={meetingId || undefined}
          presetDate={createMeeting?.date}
          presetAttendeeIds={createMeeting?.attendeeIds}
          onClose={() => { setCreateMeeting(null); setMeetingId(null); }}
        />
      )}
    </div>
  );
}

export interface ShellApi {
  openTask: (id: string) => void;
  openCreateTask: (teamId?: string) => void;
  openCreateMeeting: (date?: string, attendeeIds?: string[]) => void;
  openMeeting: (id: string) => void;
}

export function useShell() {
  return useOutletContext<ShellApi>();
}

interface BeforeInstallPrompt extends Event {
  prompt: () => Promise<void>;
}

declare global {
  interface Navigator {
    standalone?: boolean;
  }
}
