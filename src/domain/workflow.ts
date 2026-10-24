import type { Task, TaskStatus, TaskWorkflow, TeamMember, User, UserScope } from "./types";
import { canReview, canWorkTask } from "./permissions";

const NEXT: Record<TaskStatus, TaskStatus[]> = {
  "To Do": ["In Progress", "Blocked"],
  "In Progress": ["Under Review", "Blocked", "To Do"],
  Blocked: ["In Progress", "To Do"],
  "Under Review": ["Completed", "In Progress"],
  Completed: ["In Progress"],
};

export function transitionAllowed(input: {
  actor: User;
  task: Task;
  workflow?: TaskWorkflow;
  users: User[];
  scopes: UserScope[];
  members?: TeamMember[];
  to: TaskStatus;
  reason?: string;
}): string | null {
  const { actor, task, workflow, users, scopes, to } = input;
  const members = input.members ?? [];
  if (!NEXT[task.Status].includes(to)) {
    return `Cannot move a task from ${task.Status} to ${to}.`;
  }
  if (to === "Blocked" && !input.reason?.trim()) return "Blocked tasks require a reason.";
  if (task.Status === "Under Review" && (to === "Completed" || to === "In Progress")) {
    if (!canReview(actor, task, workflow, users, scopes, members)) return "You cannot review this task.";
    if (to === "In Progress" && !input.reason?.trim()) return "Add a note explaining what needs to change.";
    return null;
  }
  if (task.Status === "Completed" && to === "In Progress") {
    if (actor.Access_Role !== "Admin") return "Only an administrator can reopen a completed task.";
    return null;
  }
  if (!canWorkTask(actor, task, users, scopes, members)) return "You cannot update this task.";
  return null;
}

export function allowedTargets(input: {
  actor: User;
  task: Task;
  workflow?: TaskWorkflow;
  users: User[];
  scopes: UserScope[];
  members?: TeamMember[];
}): TaskStatus[] {
  return NEXT[input.task.Status].filter(
    (status) => transitionAllowed({ ...input, to: status, reason: status === "Blocked" || (input.task.Status === "Under Review" && status === "In Progress") ? "ok" : undefined }) === null,
  );
}
