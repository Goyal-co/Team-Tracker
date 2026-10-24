import type { Priority, TaskStatus } from "../domain/types";
import { cn } from "../lib";

const PRIORITY: Record<Priority, string> = {
  Urgent: "bg-red-100 text-red-800",
  High: "bg-orange-100 text-orange-800",
  Medium: "bg-blue-100 text-blue-800",
  Low: "bg-slate-200 text-slate-700",
};

const STATUS: Record<TaskStatus, string> = {
  "To Do": "bg-slate-200 text-slate-700",
  "In Progress": "bg-blue-100 text-blue-800",
  "Under Review": "bg-amber-100 text-amber-900",
  Blocked: "bg-rose-100 text-rose-800",
  Completed: "bg-emerald-100 text-emerald-800",
};

const lozenge = "inline-flex items-center rounded-[3px] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide";

export function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className={cn(lozenge, PRIORITY[priority])}>{priority}</span>;
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={cn(lozenge, STATUS[status])}>{status}</span>;
}

export function OverdueBadge() {
  return <span className={cn(lozenge, "bg-red-100 text-red-800")}>Overdue</span>;
}

export const STATUS_DOT: Record<TaskStatus, string> = {
  "To Do": "bg-slate-400",
  "In Progress": "bg-[#0C66E4]",
  "Under Review": "bg-amber-500",
  Blocked: "bg-rose-500",
  Completed: "bg-emerald-500",
};
