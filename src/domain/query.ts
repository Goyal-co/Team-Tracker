import { endOfMonth, endOfWeek, isOverdue, kolkataDayFromIso, startOfMonth, startOfWeek } from "./dates";
import type { Priority, Task } from "./types";

export interface TaskFilters {
  search?: string;
  employeeId?: string;
  department?: string;
  project?: string;
  projectId?: string;
  teamId?: string;
  type?: string;
  priority?: string;
  status?: string;
  deadline?: string;
  period?: string;
}

const PRIORITY_RANK: Record<Priority, number> = { Urgent: 0, High: 1, Medium: 2, Low: 3 };

export function applyTaskFilters(
  tasks: Task[],
  filters: TaskFilters,
  today: string,
  names: Map<string, string> = new Map(),
): Task[] {
  const weekStart = startOfWeek(today);
  const weekEnd = endOfWeek(today);
  const monthStart = startOfMonth(today);
  const monthEnd = endOfMonth(today);
  const search = filters.search?.trim().toLowerCase() ?? "";
  return tasks.filter((task) => {
    if (filters.employeeId && task.Assigned_To !== filters.employeeId) return false;
    if (filters.department && task.Department !== filters.department) return false;
    if (filters.project && task.Project !== filters.project) return false;
    if (filters.projectId && task.Project_ID !== filters.projectId) return false;
    if (filters.teamId && task.Team_ID !== filters.teamId) return false;
    if (filters.type && task.Type !== filters.type) return false;
    if (filters.priority && task.Priority !== filters.priority) return false;
    if (filters.status === "open" && task.Status === "Completed") return false;
    if (filters.status && filters.status !== "all" && filters.status !== "open" && task.Status !== filters.status) return false;
    if (filters.deadline === "overdue" && !isOverdue(task, today)) return false;
    if (filters.deadline === "today" && task.Due_Date !== today) return false;
    if (filters.deadline === "week" && (task.Due_Date < weekStart || task.Due_Date > weekEnd)) return false;
    if (filters.deadline === "month" && (task.Due_Date < monthStart || task.Due_Date > monthEnd)) return false;
    if (search) {
      const blob = [
        task.Task_ID,
        task.Key,
        task.Task_Title,
        task.Labels,
        task.Type,
        task.Project,
        task.Department,
        names.get(task.Assigned_To) ?? "",
        names.get(task.Assigned_By) ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!blob.includes(search)) return false;
    }
    if (filters.period === "week" || filters.period === "month") {
      const start = filters.period === "week" ? weekStart : monthStart;
      const end = filters.period === "week" ? weekEnd : monthEnd;
      const dueIn = task.Due_Date >= start && task.Due_Date <= end;
      const completedDay = task.Completed_At ? kolkataDayFromIso(task.Completed_At) : "";
      const completedIn = Boolean(completedDay && completedDay >= start && completedDay <= end);
      if (!dueIn && !completedIn && !isOverdue(task, today)) return false;
    }
    return true;
  });
}

export function sortTasks(tasks: Task[], sort: "due" | "priority" | "updated"): Task[] {
  const copy = [...tasks];
  copy.sort((a, b) => {
    if (sort === "priority") {
      const rank = PRIORITY_RANK[a.Priority] - PRIORITY_RANK[b.Priority];
      if (rank !== 0) return rank;
      return a.Due_Date.localeCompare(b.Due_Date);
    }
    if (sort === "updated") return b.Updated_At.localeCompare(a.Updated_At);
    return a.Due_Date.localeCompare(b.Due_Date) || PRIORITY_RANK[a.Priority] - PRIORITY_RANK[b.Priority];
  });
  return copy;
}

export function completedInRange(task: Task, start: string, end: string): boolean {
  if (task.Status !== "Completed" || !task.Completed_At) return false;
  const day = kolkataDayFromIso(task.Completed_At);
  return day >= start && day <= end;
}
