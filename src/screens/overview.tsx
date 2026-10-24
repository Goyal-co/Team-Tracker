import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { formatDay, formatTime, greeting, isOverdue, kolkataDayFromIso, kolkataToday } from "../domain/dates";
import { firstName } from "../domain/format";
import { applyTaskFilters } from "../domain/query";
import type { Task, TaskStatus } from "../domain/types";
import { useWorkspace } from "../state";
import { useToast } from "../toast";
import { ActivityFeed } from "../components/activity-feed";
import { useShell } from "../components/shell";
import { OverdueBadge, PriorityBadge, StatusBadge } from "../components/badges";
import { FilterBar, filterControlClass } from "../components/filters";
import { TaskBoard } from "../components/task-board";
import { Button, SelectInput } from "../components/ui";

export function OverviewPage() {
  const { data, transitionTask } = useWorkspace();
  const shell = useShell();
  const toast = useToast();
  const today = kolkataToday();
  const [view, setView] = useState<"board" | "list">("board");
  const [teamId, setTeamId] = useState("");
  const [employee, setEmployee] = useState("");
  const [projectId, setProjectId] = useState("");
  const [period, setPeriod] = useState("all");
  const names = useMemo(() => new Map(data.users.map((user) => [user.User_ID, user.Name])), [data.users]);
  const tasks = applyTaskFilters(data.tasks, { teamId, employeeId: employee, projectId, period }, today, names);
  const now = new Date().toISOString();
  const meetings = data.meetings
    .filter((meeting) => meeting.Status === "Scheduled" && meeting.End_DateTime >= now)
    .filter((meeting) => !employee || meeting.Attendees.split(",").includes(employee) || meeting.Organized_By === employee)
    .sort((a, b) => a.Start_DateTime.localeCompare(b.Start_DateTime))
    .slice(0, 6);
  const activity = data.activity.slice(0, 6);
  const mine = data.members.filter((member) => member.User_ID === data.me.User_ID && member.Status === "Active");
  const groups = data.teams.filter((team) => team.Status === "Active" && mine.some((member) => member.Team_ID === team.Team_ID));

  async function move(task: Task, to: TaskStatus) {
    const reason = to === "Blocked" ? window.prompt("Why is this blocked?") ?? "" : "";
    if (to === "Blocked" && !reason.trim()) return;
    try {
      await transitionTask(task.Task_ID, { Updated_At: task.Updated_At, to, reason });
      toast(to === "Under Review" ? "Sent to the person who assigned it." : "Work moved.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "That move is not allowed.", "error");
    }
  }

  async function exportWork() {
    try {
      const response = await fetch("/api/export/work", { credentials: "include" });
      if (!response.ok) throw new Error("The export could not be downloaded.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "goyal-work.csv";
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast(error instanceof Error ? error.message : "The export could not be downloaded.", "error");
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">{greeting()}, {firstName(data.me.Name)}</h1>
          <p className="mt-1 text-[13px] text-muted">{data.me.Access_Role === "Employee" ? "Here's the work assigned to you." : "Here's the work across the teams you can see."}</p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={() => void exportWork()}>Export</Button>
          <div className="flex rounded-[10px] border border-line bg-white p-0.5">
            {(["board", "list"] as const).map((item) => (
              <button key={item} type="button" className={`h-8 rounded-lg px-3 text-[13px] capitalize ${view === item ? "bg-accent-soft font-medium text-accent" : "text-muted"}`} onClick={() => setView(item)}>{item}</button>
            ))}
          </div>
        </div>
      </div>
      {data.teams.length === 0 && data.me.Access_Role === "Admin" && <p className="mt-3 rounded-xl border border-line bg-white px-3 py-2 text-[13px]">Create a group under Workspaces, then add people. Nothing is created until you do.</p>}
      <div className="mt-4">
        <FilterBar
          active={[teamId, projectId, employee, period !== "all" ? period : ""].filter(Boolean).length}
          onReset={() => { setTeamId(""); setEmployee(""); setProjectId(""); setPeriod("all"); }}
        >
          <SelectInput value={teamId} onChange={(event) => { setTeamId(event.target.value); setProjectId(""); }} className={filterControlClass}>
            <option value="">All teams</option>
            {data.teams.filter((team) => team.Status === "Active").map((team) => <option key={team.Team_ID} value={team.Team_ID}>{team.Name}</option>)}
          </SelectInput>
          <SelectInput value={projectId} onChange={(event) => setProjectId(event.target.value)} className={filterControlClass}>
            <option value="">All projects</option>
            {data.projects.filter((project) => project.Status === "Active" && (!teamId || project.Team_ID === teamId)).map((project) => <option key={project.Project_ID} value={project.Project_ID}>{project.Key}</option>)}
          </SelectInput>
          <SelectInput value={employee} onChange={(event) => setEmployee(event.target.value)} className={filterControlClass}>
            <option value="">All people</option>
            {data.users.filter((user) => user.Status === "Active").map((user) => <option key={user.User_ID} value={user.User_ID}>{user.Name}</option>)}
          </SelectInput>
          <SelectInput value={period} onChange={(event) => setPeriod(event.target.value)} className={filterControlClass}>
            <option value="all">All dates</option>
            <option value="week">This week</option>
            <option value="month">This month</option>
          </SelectInput>
        </FilterBar>
      </div>
      <div className="mt-4 flex flex-col gap-4 xl:flex-row xl:items-start">
        <section className="min-w-0 flex-1">
          <h2 className="mb-2 text-[13px] font-semibold">My work</h2>
          {tasks.length === 0 && <p className="rounded-xl border border-line bg-white px-4 py-8 text-center text-[13px] text-muted">No work in this view.</p>}
          {view === "board" && tasks.length > 0 && <TaskBoard tasks={tasks} names={names} today={today} onOpen={shell.openTask} onMove={(task, to) => void move(task, to)} />}
          {view === "list" && tasks.length > 0 && (
            <ul className="space-y-2">
              {tasks.map((task) => (
                <li key={task.Task_ID}>
                  <button type="button" className="flex w-full flex-wrap items-center gap-2 rounded-xl border border-line bg-white px-4 py-3 text-left" onClick={() => shell.openTask(task.Task_ID)}>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[11px] font-semibold text-accent">{task.Key || task.Task_ID}</span>
                      <span className="block text-[14px] font-medium">{task.Task_Title}</span>
                    </span>
                    <PriorityBadge priority={task.Priority} />
                    <StatusBadge status={task.Status} />
                    {isOverdue(task, today) && <OverdueBadge />}
                    <span className="text-[12px] text-muted">{names.get(task.Assigned_To)}</span>
                    <span className="text-[12px] text-muted">{task.Due_Date}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="w-full shrink-0 rounded-xl border border-line bg-white xl:w-72">
          <header className="border-b border-line px-4 py-3 text-[13px] font-semibold">Coming up</header>
            <ul className="divide-y divide-line">
              {meetings.length === 0 && <li className="px-4 py-6 text-[13px] text-muted">No meetings to join.</li>}
              {meetings.map((meeting) => {
                const live = meeting.Start_DateTime <= now && meeting.End_DateTime >= now;
                const day = kolkataDayFromIso(meeting.Start_DateTime);
                const when = live ? "Now" : day === today ? "Today" : formatDay(day);
                return (
                  <li key={meeting.Meeting_ID} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{meeting.Meeting_Title}</p>
                      <p className="mt-0.5 text-[12px] text-muted">{when} · {formatTime(meeting.Start_DateTime)}{meeting.Google_Meet_Link ? "" : meeting.Location ? ` · ${meeting.Location}` : " · In person"}</p>
                    </div>
                    {meeting.Google_Meet_Link ? (
                      <a href={meeting.Google_Meet_Link} target="_blank" rel="noreferrer" className="inline-flex h-8 shrink-0 items-center rounded-md bg-accent px-3 text-[13px] font-medium text-white hover:bg-[#0055CC]">Join</a>
                    ) : (
                      <span className="shrink-0 text-[12px] text-muted">In person</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
      </div>
      <section className="mt-4">
        <h2 className="text-[13px] font-semibold">Your groups</h2>
        {groups.length === 0 && <p className="mt-2 text-[13px] text-muted">You are not in a group yet.</p>}
        <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {groups.map((team) => {
            const membership = mine.find((member) => member.Team_ID === team.Team_ID);
            const leads = membership?.Member_Role === "Lead" || data.me.Access_Role === "Manager" || data.me.Access_Role === "Admin";
            const place = membership?.Member_Role === "Lead" ? "You lead this group" : data.me.Access_Role === "Manager" || data.me.Access_Role === "Admin" ? "You oversee this group" : "You are in this group";
            const items = data.tasks.filter((task) => task.Team_ID === team.Team_ID);
            const open = items.filter((task) => task.Status !== "Completed");
            const late = open.filter((task) => isOverdue(task, today)).length;
            const blocked = items.filter((task) => task.Status === "Blocked").length;
            const done = items.length - open.length;
            const state = items.length === 0 ? "No work yet" : late > 0 ? "Behind" : blocked > 0 ? "Some work is blocked" : "On track";
            const loads = leads
              ? data.members
                .filter((member) => member.Team_ID === team.Team_ID && member.Status === "Active")
                .map((member) => ({ name: names.get(member.User_ID) ?? "Someone", count: open.filter((task) => task.Assigned_To === member.User_ID).length }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 3)
              : [];
            return (
              <button key={team.Team_ID} type="button" className={`rounded-xl border bg-white p-4 text-left hover:border-accent ${teamId === team.Team_ID ? "border-accent" : "border-line"}`} onClick={() => setTeamId(team.Team_ID === teamId ? "" : team.Team_ID)}>
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-[14px] font-semibold">{team.Name}</span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${state === "Behind" ? "bg-red-50 text-red-700" : state === "On track" ? "bg-emerald-50 text-emerald-700" : "bg-canvas text-muted"}`}>{state}</span>
                </span>
                <span className="mt-1 block text-[12px] text-muted">{place}</span>
                <span className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <span><span className="block text-[18px] font-semibold">{open.length}</span><span className="text-[11px] text-muted">Open</span></span>
                  <span><span className="block text-[18px] font-semibold">{late}</span><span className="text-[11px] text-muted">Overdue</span></span>
                  <span><span className="block text-[18px] font-semibold">{done}</span><span className="text-[11px] text-muted">Done</span></span>
                </span>
                {loads.length > 0 && (
                  <span className="mt-3 block space-y-1">
                    {loads.map((person) => (
                      <span key={person.name} className="flex justify-between text-[12px] text-muted"><span className="truncate">{person.name}</span><span>{person.count} open</span></span>
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>
      <section className="mt-4 overflow-hidden rounded-xl border border-line bg-white">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-[13px] font-semibold">Recent activity</h2>
          <Link to="/activity" className="text-[12px] font-medium text-accent">View all</Link>
        </header>
        <ActivityFeed items={activity} users={data.users} tasks={data.tasks} meetings={data.meetings} onOpenTask={shell.openTask} onOpenMeeting={shell.openMeeting} />
      </section>
    </div>
  );
}
