import { useMemo, useState } from "react";
import { addDays, formatDay, isOverdue, kolkataToday, startOfMonth, startOfWeek, weekdayIndex } from "../domain/dates";
import { splitIds } from "../domain/ids";
import { tasksNeedingMyReview } from "../domain/inbox";
import { allowedTargets } from "../domain/workflow";
import type { Task, TaskStatus } from "../domain/types";
import { useWorkspace } from "../state";
import { useToast } from "../toast";
import { useShell } from "../components/shell";
import { OverdueBadge, PriorityBadge, StatusBadge } from "../components/badges";
import { filterControlClass } from "../components/filters";
import { TaskBoard } from "../components/task-board";
import { Button, EmptyState, PageHeader, SelectInput } from "../components/ui";

type Group = "Overdue" | "Today" | "Upcoming" | "Completed";
type Scope = "assigned" | "created" | "cc" | "review" | "all";

function groupOf(task: Task, today: string): Group {
  if (task.Status === "Completed") return "Completed";
  if (isOverdue(task, today)) return "Overdue";
  if (task.Due_Date === today) return "Today";
  return "Upcoming";
}

function matchesScope(task: Task, userId: string, scope: Scope) {
  const onCc = splitIds(task.CC_User_Ids || "").includes(userId);
  if (scope === "assigned") return task.Assigned_To === userId;
  if (scope === "created") return task.Assigned_By === userId;
  if (scope === "cc") return onCc;
  if (scope === "review") return false;
  return task.Assigned_To === userId || task.Assigned_By === userId || onCc;
}

export function MyTasksPage() {
  const { data, transitionTask } = useWorkspace();
  const shell = useShell();
  const toast = useToast();
  const [view, setView] = useState<"list" | "board" | "calendar">("board");
  const [group, setGroup] = useState<Group | "All">("All");
  const [scope, setScope] = useState<Scope>("assigned");
  const [teamId, setTeamId] = useState("");
  const today = kolkataToday();
  const reviewQueue = tasksNeedingMyReview(data);
  const mine = scope === "review"
    ? reviewQueue.filter((task) => !teamId || task.Team_ID === teamId)
    : data.tasks.filter((task) => matchesScope(task, data.me.User_ID, scope) && (!teamId || task.Team_ID === teamId));
  const names = useMemo(() => new Map(data.users.map((user) => [user.User_ID, user.Name])), [data.users]);
  const visible = mine.filter((task) => group === "All" || groupOf(task, today) === group);

  async function quick(task: Task) {
    const targets = allowedTargets({ actor: data.me, task, workflow: data.workflows.find((item) => item.Task_ID === task.Task_ID), users: data.users, scopes: data.scopes, members: data.members });
    const next: TaskStatus | undefined =
      task.Status === "To Do" && targets.includes("In Progress") ? "In Progress"
      : task.Status === "In Progress" && targets.includes("Under Review") ? "Under Review"
      : task.Status === "Blocked" && targets.includes("In Progress") ? "In Progress"
      : undefined;
    if (!next) {
      shell.openTask(task.Task_ID);
      return;
    }
    try {
      await transitionTask(task.Task_ID, { Updated_At: task.Updated_At, to: next, reason: "" });
      toast(next === "Under Review" ? "Submitted for review. The creator and managers on CC can approve it." : "Status updated.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not update the task.", "error");
    }
  }

  return (
    <div>
      <PageHeader title="My work" subtitle={scope === "review" ? "Work waiting for your approval." : "Work assigned to you, that you created, or where you are on CC."} actions={
        <div className="flex max-w-full overflow-x-auto rounded-[10px] border border-line bg-white p-0.5">
          {(["list", "board", "calendar"] as const).map((item) => (
            <button key={item} type="button" className={`h-8 shrink-0 rounded-lg px-3 text-[13px] capitalize ${view === item ? "bg-accent-soft font-medium text-accent" : "text-muted"}`} onClick={() => setView(item)}>{item}</button>
          ))}
        </div>
      } />
      {reviewQueue.length > 0 && scope !== "review" && (
        <button
          type="button"
          className="mb-3 flex w-full items-center justify-between gap-2 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3 text-left"
          onClick={() => { setScope("review"); setGroup("All"); setView("list"); }}
        >
          <span>
            <span className="block text-[13px] font-semibold text-ink">Needs your review</span>
            <span className="block text-[12px] text-muted">{reviewQueue.length} {reviewQueue.length === 1 ? "task is" : "tasks are"} waiting for approval</span>
          </span>
          <span className="rounded-full bg-accent px-2.5 py-1 text-[12px] font-semibold text-white">{reviewQueue.length}</span>
        </button>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SelectInput value={scope} onChange={(event) => setScope(event.target.value as Scope)} className={filterControlClass}>
          <option value="assigned">Assigned to me</option>
          <option value="created">I created</option>
          <option value="cc">I'm on CC</option>
          <option value="review">To review{reviewQueue.length ? ` (${reviewQueue.length})` : ""}</option>
          <option value="all">All involving me</option>
        </SelectInput>
        <SelectInput value={teamId} onChange={(event) => setTeamId(event.target.value)} className={filterControlClass}>
          <option value="">All workspaces</option>
          {data.teams.filter((team) => team.Status === "Active").map((team) => <option key={team.Team_ID} value={team.Team_ID}>{team.Name}</option>)}
        </SelectInput>
      </div>
      <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
        {(["All", "Overdue", "Today", "Upcoming", "Completed"] as const).map((item) => (
          <button key={item} type="button" className={`h-8 shrink-0 rounded-full px-3 text-[13px] ${group === item ? "bg-ink text-white" : "bg-white text-muted ring-1 ring-line"}`} onClick={() => setGroup(item)}>
            {item} {item === "All" ? mine.length : mine.filter((task) => groupOf(task, today) === item).length}
          </button>
        ))}
      </div>
      {visible.length === 0 && <EmptyState title="Nothing in this view" body={scope === "assigned" ? "Tasks assigned to you will show up here." : scope === "created" ? "Tasks you create will show up here." : scope === "cc" ? "Tasks where you are on CC will show up here." : scope === "review" ? "When someone submits work for your review, it will show up here." : "Work that involves you will show up here."} />}
      {view === "list" && visible.length > 0 && (
        <div className="space-y-2">
          {visible.map((task) => (
            <article key={task.Task_ID} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-white px-4 py-3">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => shell.openTask(task.Task_ID)}>
                <span className="block text-[11px] font-semibold text-accent">{task.Key || task.Task_ID}</span>
                <span className="block text-[14px] font-medium">{task.Task_Title}</span>
                <span className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                  <PriorityBadge priority={task.Priority} />
                  <StatusBadge status={task.Status} />
                  {isOverdue(task, today) && <OverdueBadge />}
                  <span>Due {formatDay(task.Due_Date)}</span>
                  <span>From {names.get(task.Assigned_By)}</span>
                  {task.Project && <span>{task.Project}</span>}
                </span>
              </button>
              {scope === "review" ? (
                <Button
                  type="button"
                  onClick={() => {
                    void transitionTask(task.Task_ID, { Updated_At: task.Updated_At, to: "Completed", reason: "" })
                      .then(() => toast("Task approved."))
                      .catch((error: unknown) => toast(error instanceof Error ? error.message : "Could not approve that task.", "error"));
                  }}
                >
                  Approve
                </Button>
              ) : (
                <Button type="button" variant="secondary" onClick={() => void quick(task)}>
                  {task.Status === "To Do" ? "Start" : task.Status === "In Progress" ? (task.Type === "Bug" ? "Ready to verify" : "Submit for review") : task.Status === "Blocked" ? "Resume" : "Open"}
                </Button>
              )}
            </article>
          ))}
        </div>
      )}
      {view === "board" && visible.length > 0 && (
        <TaskBoard
          tasks={visible}
          names={names}
          today={today}
          onOpen={shell.openTask}
          onMove={(task, to) => {
            const reason = to === "Blocked" ? window.prompt("Why is this blocked?") ?? "" : "";
            if (to === "Blocked" && !reason.trim()) return;
            void transitionTask(task.Task_ID, { Updated_At: task.Updated_At, to, reason })
              .then(() => toast(to === "Under Review" ? "Submitted for review." : to === "Completed" ? "Task approved." : "Work moved."))
              .catch((error: unknown) => toast(error instanceof Error ? error.message : "That move is not allowed.", "error"));
          }}
        />
      )}
      {view === "calendar" && <MonthDue tasks={visible} today={today} onOpen={shell.openTask} />}
    </div>
  );
}

function MonthDue({ tasks, today, onOpen }: { tasks: Task[]; today: string; onOpen: (id: string) => void }) {
  const [cursor, setCursor] = useState(today);
  const start = startOfMonth(cursor);
  const gridStart = startOfWeek(start);
  const days = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
  return (
    <div className="rounded-xl border border-line bg-white">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <button type="button" className="text-[13px] text-accent" onClick={() => setCursor(addDays(start, -1))}>Previous</button>
        <span className="text-[13px] font-semibold">{formatDay(start).replace(/^\d+\s/, "")}</span>
        <button type="button" className="text-[13px] text-accent" onClick={() => setCursor(addDays(start, 32))}>Next</button>
      </div>
      <div className="grid grid-cols-7 text-[11px] text-muted">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <div key={day} className="px-2 py-1">{day}</div>)}</div>
      <div className="grid grid-cols-7">
        {days.map((day) => (
          <div key={day} className={`min-h-20 border-t border-line p-1 ${day.slice(0, 7) === start.slice(0, 7) ? "" : "bg-slate-50 text-muted"} ${weekdayIndex(day) === 0 || weekdayIndex(day) === 6 ? "" : ""}`}>
            <span className={`text-[11px] ${day === today ? "font-semibold text-accent" : ""}`}>{Number(day.slice(8))}</span>
            {tasks.filter((task) => task.Due_Date === day).slice(0, 3).map((task) => (
              <button key={task.Task_ID} type="button" className="mt-1 block w-full truncate rounded bg-accent-soft px-1 text-left text-[11px] text-accent" onClick={() => onOpen(task.Task_ID)}>{task.Task_Title}</button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
