import { canReview } from "./permissions";
import type { Bootstrap, Notification, Task } from "./types";

export function tasksNeedingMyReview(data: Pick<Bootstrap, "tasks" | "workflows" | "users" | "scopes" | "members" | "me">): Task[] {
  return data.tasks
    .filter((task) => {
      if (task.Status !== "Under Review") return false;
      const workflow = data.workflows.find((item) => item.Task_ID === task.Task_ID);
      return canReview(data.me, task, workflow, data.users, data.scopes, data.members);
    })
    .slice()
    .sort((a, b) => b.Updated_At.localeCompare(a.Updated_At));
}

export function chatUnreadNotes(notifications: Notification[]): Notification[] {
  return notifications.filter((item) => !item.Read_At && (
    (item.Type === "direct_message" && item.Entity_Type === "user")
    || (item.Type === "mentioned" && item.Entity_Type === "team")
  ));
}

export function unreadForPerson(notifications: Notification[], userId: string) {
  return chatUnreadNotes(notifications).filter((item) => item.Type === "direct_message" && item.Entity_ID === userId);
}

export function unreadForTeam(notifications: Notification[], teamId: string) {
  return chatUnreadNotes(notifications).filter((item) => item.Type === "mentioned" && item.Entity_Type === "team" && item.Entity_ID === teamId);
}
