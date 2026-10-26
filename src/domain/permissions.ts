import type { AccessRole, Meeting, Task, TaskWorkflow, TeamMember, User, UserScope } from "./types";
import { splitIds } from "./ids";

export function managerIds(user: User): string[] {
  return splitIds(user.Reports_To);
}

export function descendantIds(users: User[], managerId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const user of users) {
    for (const managerIdOfUser of managerIds(user)) {
      const list = children.get(managerIdOfUser) ?? [];
      list.push(user.User_ID);
      children.set(managerIdOfUser, list);
    }
  }
  const result = new Set<string>();
  const seen = new Set<string>();
  const stack = [...(children.get(managerId) ?? [])];
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    result.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return result;
}

export function scopedUserIds(actor: User, users: User[], scopes: UserScope[]): Set<string> {
  if (actor.Access_Role === "Admin") return new Set(users.map((user) => user.User_ID));
  const ids = new Set<string>([actor.User_ID]);
  if (actor.Access_Role === "Employee") return ids;
  for (const id of descendantIds(users, actor.User_ID)) ids.add(id);
  if (actor.Access_Role === "Coordinator") {
    for (const scope of scopes) {
      if (scope.User_ID !== actor.User_ID) continue;
      if (scope.Scope_Type === "user") ids.add(scope.Scope_Value);
      if (scope.Scope_Type === "department") {
        for (const user of users) {
          if (user.Department === scope.Scope_Value) ids.add(user.User_ID);
        }
      }
    }
  }
  return ids;
}

export function canCreateTasks(actor: User, members: TeamMember[] = []): boolean {
  if (actor.Status !== "Active") return false;
  if (actor.Access_Role === "Admin") return true;
  return members.some((member) => member.User_ID === actor.User_ID && member.Status === "Active");
}

export function canBulkEdit(actor: User): boolean {
  return actor.Access_Role === "Admin" || actor.Access_Role === "Manager";
}

export function canManageUsers(actor: User): boolean {
  return actor.Access_Role === "Admin";
}

export function onTeam(members: TeamMember[], userId: string, teamId: string): boolean {
  return members.some((member) => member.User_ID === userId && member.Team_ID === teamId && member.Status === "Active");
}

function inWorkspace(actor: User, members: TeamMember[]): boolean {
  if (actor.Status !== "Active") return false;
  if (actor.Access_Role === "Admin") return true;
  return members.some((member) => member.User_ID === actor.User_ID && member.Status === "Active");
}

export function canAssignTo(actor: User, assigneeId: string, _users: User[], _scopes: UserScope[], members: TeamMember[] = [], teamId = ""): boolean {
  if (actor.Status !== "Active" || !teamId) return false;
  if (actor.Access_Role !== "Admin" && !onTeam(members, actor.User_ID, teamId)) return false;
  return onTeam(members, assigneeId, teamId);
}

export function effectiveReviewer(task: Task, workflow?: TaskWorkflow): string {
  return workflow?.Reviewer_ID || task.Assigned_By;
}

export function canViewTask(actor: User, task: Task, workflow: TaskWorkflow | undefined, users: User[], scopes: UserScope[], members: TeamMember[] = []): boolean {
  if (!inWorkspace(actor, members)) return false;
  if (actor.Access_Role !== "Admin" && task.Team_ID && !onTeam(members, actor.User_ID, task.Team_ID)) return false;
  if (actor.Access_Role === "Admin") return true;
  if (task.Assigned_To === actor.User_ID || task.Assigned_By === actor.User_ID) return true;
  if (effectiveReviewer(task, workflow) === actor.User_ID) return true;
  if (actor.Access_Role === "Manager" || actor.Access_Role === "Coordinator") {
    return scopedUserIds(actor, users, scopes).has(task.Assigned_To);
  }
  return false;
}

export function canEditTaskMetadata(actor: User, task: Task, users: User[], scopes: UserScope[], members: TeamMember[] = []): boolean {
  if (!inWorkspace(actor, members)) return false;
  if (actor.Access_Role !== "Admin" && task.Team_ID && !onTeam(members, actor.User_ID, task.Team_ID)) return false;
  if (actor.Access_Role === "Employee") return false;
  if (actor.Access_Role === "Admin") return true;
  return scopedUserIds(actor, users, scopes).has(task.Assigned_To);
}

export function canWorkTask(actor: User, task: Task, users: User[], scopes: UserScope[], members: TeamMember[] = []): boolean {
  if (!inWorkspace(actor, members)) return false;
  if (actor.Access_Role !== "Admin" && task.Team_ID && !onTeam(members, actor.User_ID, task.Team_ID)) return false;
  if (actor.Access_Role === "Admin") return true;
  if (task.Assigned_To === actor.User_ID) return true;
  if (actor.Access_Role === "Manager" || actor.Access_Role === "Coordinator") {
    return scopedUserIds(actor, users, scopes).has(task.Assigned_To);
  }
  return false;
}

export function canReview(actor: User, task: Task, workflow: TaskWorkflow | undefined, users: User[], scopes: UserScope[], members: TeamMember[] = []): boolean {
  if (!inWorkspace(actor, members)) return false;
  if (actor.Access_Role !== "Admin" && task.Team_ID && !onTeam(members, actor.User_ID, task.Team_ID)) return false;
  if (actor.Access_Role === "Admin") return true;
  if (effectiveReviewer(task, workflow) === actor.User_ID) return true;
  if (actor.Access_Role === "Manager" && scopedUserIds(actor, users, scopes).has(task.Assigned_To)) return true;
  return false;
}

export function meetingAttendeeIds(meeting: Meeting): string[] {
  return Array.from(new Set([meeting.Organized_By, ...splitIds(meeting.Attendees)]));
}

export function canViewMeeting(actor: User, meeting: Meeting, users: User[], scopes: UserScope[], members: TeamMember[] = []): boolean {
  if (!inWorkspace(actor, members)) return false;
  if (actor.Access_Role === "Admin") return true;
  const people = meetingAttendeeIds(meeting);
  if (people.includes(actor.User_ID)) return true;
  if (actor.Access_Role === "Manager" || actor.Access_Role === "Coordinator") {
    const scope = scopedUserIds(actor, users, scopes);
    return people.some((id) => scope.has(id));
  }
  return false;
}

export function canViewActivity(
  actor: User,
  log: { Actor_ID: string; Entity_Type: string; Entity_ID: string },
  tasks: Task[],
  workflows: TaskWorkflow[],
  meetings: Meeting[],
  users: User[],
  scopes: UserScope[],
  members: TeamMember[] = [],
): boolean {
  if (!inWorkspace(actor, members) && log.Entity_ID !== actor.User_ID) return false;
  if (actor.Access_Role === "Admin") return true;
  if (log.Entity_Type === "user") return log.Entity_ID === actor.User_ID;
  if (log.Entity_Type === "team") return onTeam(members, actor.User_ID, log.Entity_ID);
  if (log.Actor_ID === actor.User_ID) {
    if (log.Entity_Type === "task") {
      const task = tasks.find((item) => item.Task_ID === log.Entity_ID);
      return task ? canViewTask(actor, task, workflows.find((item) => item.Task_ID === task.Task_ID), users, scopes, members) : false;
    }
    if (log.Entity_Type === "meeting") {
      const meeting = meetings.find((item) => item.Meeting_ID === log.Entity_ID);
      return meeting ? canViewMeeting(actor, meeting, users, scopes, members) : false;
    }
  }
  if (log.Entity_Type === "task") {
    const task = tasks.find((item) => item.Task_ID === log.Entity_ID);
    return task ? canViewTask(actor, task, workflows.find((item) => item.Task_ID === task.Task_ID), users, scopes, members) : false;
  }
  if (log.Entity_Type === "meeting") {
    const meeting = meetings.find((item) => item.Meeting_ID === log.Entity_ID);
    return meeting ? canViewMeeting(actor, meeting, users, scopes, members) : false;
  }
  return false;
}

export function workloadLabel(activeCount: number): "Light" | "Steady" | "Heavy" {
  if (activeCount <= 2) return "Light";
  if (activeCount <= 4) return "Steady";
  return "Heavy";
}

export function roleRank(role: AccessRole): number {
  return { Admin: 0, Manager: 1, Coordinator: 2, Employee: 3 }[role];
}
