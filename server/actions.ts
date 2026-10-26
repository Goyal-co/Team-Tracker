import { addDays, isOverdue, kolkataToday, kolkataToIso } from "../src/domain/dates";
import { isPlaceholderEmail, joinIds, nextId } from "../src/domain/ids";
import {
  canAssignTo,
  canBulkEdit,
  canCreateTasks,
  canEditTaskMetadata,
  canManageUsers,
  canViewActivity,
  canViewMeeting,
  canViewTask,
  descendantIds,
  effectiveReviewer,
  meetingAttendeeIds,
  scopedUserIds,
} from "../src/domain/permissions";
import { findSlots, mergeAvailability, overlaps, type ExternalCalendar } from "../src/domain/availability";
import { transitionAllowed } from "../src/domain/workflow";
import type {
  ActivityLog,
  Attachment,
  BusinessDb,
  Comment,
  InvitationStatus,
  Meeting,
  Notification,
  NotificationType,
  Task,
  TaskStatus,
  User,
} from "../src/domain/types";
import { mentionIds } from "../src/domain/format";
import { canInviteToTeam, hasWorkspaceAccess, higherRole, onTeam } from "../src/domain/workspace";
import { HttpError } from "./errors";

export interface GoogleEventLink {
  eventId: string;
  htmlLink: string;
  meetLink: string;
  responses?: Record<string, InvitationStatus>;
}

function nowIso() {
  return new Date().toISOString();
}

function userById(db: BusinessDb, id: string): User {
  const user = db.users.find((item) => item.User_ID === id);
  if (!user) throw new HttpError(404, "Employee not found.");
  return user;
}

function taskById(db: BusinessDb, id: string): Task {
  const task = db.tasks.find((item) => item.Task_ID === id);
  if (!task) throw new HttpError(404, "Task not found.");
  return task;
}

function meetingById(db: BusinessDb, id: string): Meeting {
  const meeting = db.meetings.find((item) => item.Meeting_ID === id);
  if (!meeting) throw new HttpError(404, "Meeting not found.");
  return meeting;
}

function workflowOf(db: BusinessDb, taskId: string) {
  return db.workflows.find((item) => item.Task_ID === taskId);
}

function ensureWorkflow(db: BusinessDb, task: Task) {
  let workflow = workflowOf(db, task.Task_ID);
  if (!workflow) {
    workflow = { Task_ID: task.Task_ID, Reviewer_ID: task.Assigned_By, Blocked_Reason: "", Review_Note: "" };
    db.workflows.push(workflow);
  }
  return workflow;
}

function nameOf(db: BusinessDb, id: string) {
  return db.users.find((user) => user.User_ID === id)?.Name ?? id;
}

function log(
  db: BusinessDb,
  actorId: string,
  action: string,
  entityType: ActivityLog["Entity_Type"],
  entityId: string,
  oldValue: string,
  newValue: string,
) {
  db.activity.unshift({
    Log_ID: nextId("L-", db.activity.map((item) => item.Log_ID), 5),
    Timestamp: nowIso(),
    Actor_ID: actorId,
    Action: action,
    Entity_Type: entityType,
    Entity_ID: entityId,
    Old_Value: oldValue,
    New_Value: newValue,
  });
}

function notify(
  db: BusinessDb,
  recipientId: string,
  actorId: string,
  type: NotificationType,
  title: string,
  body: string,
  entityType: Notification["Entity_Type"],
  entityId: string,
) {
  if (!recipientId || recipientId === actorId) return;
  db.notifications.unshift({
    Notification_ID: nextId("N-", db.notifications.map((item) => item.Notification_ID), 4),
    Recipient_ID: recipientId,
    Type: type,
    Title: title,
    Body: body,
    Entity_Type: entityType,
    Entity_ID: entityId,
    Read_At: "",
    Created_At: nowIso(),
  });
}

function assertFresh(current: string, expected: string) {
  if (current !== expected) {
    throw new HttpError(409, "This was updated by someone else. Refresh and try again.");
  }
}

function setting(db: BusinessDb, key: string, fallback: string) {
  return db.settings.find((item) => item.Key === key)?.Value || fallback;
}

function workdays(db: BusinessDb): number[] {
  return setting(db, "workdays", "1,2,3,4,5")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value));
}

export function canManageMeeting(actor: User, meeting: Meeting, db: BusinessDb) {
  if (actor.Access_Role === "Admin") return true;
  if (meeting.Organized_By === actor.User_ID) return true;
  if (actor.Access_Role === "Manager" || actor.Access_Role === "Coordinator") {
    return scopedUserIds(actor, db.users, db.scopes).has(meeting.Organized_By);
  }
  return false;
}

export function visibleData(db: BusinessDb, actor: User) {
  const tasks = hasWorkspaceAccess(db, actor)
    ? db.tasks.filter((task) => canViewTask(actor, task, workflowOf(db, task.Task_ID), db.users, db.scopes, db.members))
    : [];
  const taskIds = new Set(tasks.map((task) => task.Task_ID));
  const meetings = hasWorkspaceAccess(db, actor)
    ? db.meetings.filter((meeting) => canViewMeeting(actor, meeting, db.users, db.scopes, db.members))
    : [];
  const meetingIds = new Set(meetings.map((meeting) => meeting.Meeting_ID));
  const teamIds = actor.Access_Role === "Admin"
    ? new Set(db.teams.map((team) => team.Team_ID))
    : new Set(db.members.filter((member) => member.User_ID === actor.User_ID && member.Status === "Active").map((member) => member.Team_ID));
  const users = !hasWorkspaceAccess(db, actor)
    ? db.users.filter((user) => user.User_ID === actor.User_ID)
    : actor.Access_Role === "Admin"
      ? db.users
      : db.users.filter((user) => user.Status === "Active" || user.User_ID === actor.User_ID);
  const invites = db.invites.filter((invite) => {
    if (invite.Email.toLowerCase() === actor.Email.toLowerCase()) return true;
    return hasWorkspaceAccess(db, actor) && (actor.Access_Role === "Admin" || teamIds.has(invite.Team_ID));
  });
  return {
    access: hasWorkspaceAccess(db, actor) ? "workspace" as const : "waiting" as const,
    users,
    teams: db.teams.filter((team) => actor.Access_Role === "Admin" || teamIds.has(team.Team_ID) || invites.some((invite) => invite.Team_ID === team.Team_ID && invite.Status === "Pending")),
    members: db.members.filter((member) => actor.Access_Role === "Admin" || teamIds.has(member.Team_ID)),
    projects: db.projects.filter((project) => actor.Access_Role === "Admin" || teamIds.has(project.Team_ID)),
    invites,
    tasks,
    workflows: db.workflows.filter((item) => taskIds.has(item.Task_ID)),
    comments: db.comments.filter((item) => taskIds.has(item.Task_ID)),
    attachments: db.attachments.filter((item) => taskIds.has(item.Task_ID)),
    meetings,
    meetingDetails: db.meetingDetails.filter((item) => meetingIds.has(item.Meeting_ID)),
    activity: db.activity
      .filter((item) => canViewActivity(actor, item, db.tasks, db.workflows, db.meetings, db.users, db.scopes, db.members))
      .slice(0, 500),
    notifications: db.notifications.filter((item) => item.Recipient_ID === actor.User_ID).slice(0, 100),
    settings: db.settings,
    scopes: db.scopes,
    messages: (db.messages ?? []).filter((message) => {
      if (message.Recipient_ID) return message.Author_ID === actor.User_ID || message.Recipient_ID === actor.User_ID;
      return teamIds.has(message.Team_ID);
    }).slice(-400),
  };
}

export function ensureDerivedNotifications(db: BusinessDb, userId: string, now = new Date()) {
  const today = kolkataToday(now);
  const tomorrow = addDays(today, 1);
  for (const task of db.tasks) {
    if (task.Assigned_To !== userId || task.Status === "Completed") continue;
    const overdue = isOverdue(task, today);
    const approaching = !overdue && (task.Due_Date === today || task.Due_Date === tomorrow);
    if (!overdue && !approaching) continue;
    const type: NotificationType = overdue ? "task_overdue" : "deadline_approaching";
    const exists = db.notifications.some(
      (item) => item.Recipient_ID === userId && item.Type === type && item.Entity_ID === task.Task_ID,
    );
    if (exists) continue;
    notify(
      db,
      userId,
      "",
      type,
      overdue ? `${task.Task_Title} is overdue` : `${task.Task_Title} is due soon`,
      overdue ? `The deadline was ${task.Due_Date}.` : `Due ${task.Due_Date === today ? "today" : "tomorrow"}.`,
      "task",
      task.Task_ID,
    );
  }
}

function requireVisibleTask(db: BusinessDb, actor: User, taskId: string) {
  const task = taskById(db, taskId);
  if (!canViewTask(actor, task, workflowOf(db, task.Task_ID), db.users, db.scopes, db.members)) {
    throw new HttpError(403, "You cannot view this task.");
  }
  return task;
}

export function createTask(
  db: BusinessDb,
  actor: User,
  input: {
    Task_Title: string;
    Description: string;
    Assigned_To: string;
    Priority: Task["Priority"];
    Start_Date: string;
    Due_Date: string;
    Team_ID: string;
    Project_ID: string;
    Type: Task["Type"];
    Severity: Task["Severity"];
    Labels: string;
    Department: string;
    Reviewer_ID: string;
    Remarks: string;
  },
) {
  if (!hasWorkspaceAccess(db, actor)) throw new HttpError(403, "Accept an invite before opening the workspace.");
  if (!canCreateTasks(actor, db.members)) throw new HttpError(403, "You cannot create work.");
  const team = db.teams.find((item) => item.Team_ID === input.Team_ID && item.Status === "Active");
  if (!team) throw new HttpError(400, "Choose an active team.");
  if (actor.Access_Role !== "Admin" && !onTeam(db.members, actor.User_ID, team.Team_ID)) {
    throw new HttpError(403, "You can only add work to a team you have joined.");
  }
  const project = db.projects.find((item) => item.Project_ID === input.Project_ID && item.Status === "Active");
  if (!project || project.Team_ID !== team.Team_ID) throw new HttpError(400, "Choose a project on that team.");
  const assignee = userById(db, input.Assigned_To);
  if (assignee.Status !== "Active") throw new HttpError(400, "That person is inactive.");
  if (!canAssignTo(actor, assignee.User_ID, db.users, db.scopes, db.members, team.Team_ID)) {
    throw new HttpError(403, "You cannot assign work to that person.");
  }
  if (input.Type === "Bug" && !input.Severity) throw new HttpError(400, "A bug needs a severity.");
  const reviewer = actor;
  const stamp = nowIso();
  const number = project.Next_Number || 1;
  project.Next_Number = number + 1;
  const task: Task = {
    Task_ID: nextId("T-", db.tasks.map((item) => item.Task_ID), 4),
    Task_Title: input.Task_Title,
    Description: input.Description,
    Assigned_To: assignee.User_ID,
    Assigned_By: actor.User_ID,
    Priority: input.Priority,
    Status: "To Do",
    Start_Date: input.Start_Date,
    Due_Date: input.Due_Date,
    Created_At: stamp,
    Updated_At: stamp,
    Completed_At: "",
    Remarks: input.Remarks,
    Project: project.Name,
    Department: input.Department || assignee.Department,
    Type: input.Type,
    Team_ID: team.Team_ID,
    Project_ID: project.Project_ID,
    Key: `${project.Key}-${number}`,
    Severity: input.Type === "Bug" ? input.Severity : "",
    Labels: input.Labels,
  };
  db.tasks.unshift(task);
  db.workflows.push({ Task_ID: task.Task_ID, Reviewer_ID: reviewer.User_ID, Blocked_Reason: "", Review_Note: "" });
  log(db, actor.User_ID, "task.created", "task", task.Task_ID, "", task.Task_Title);
  log(db, actor.User_ID, "task.assigned", "task", task.Task_ID, "", assignee.Name);
  notify(db, assignee.User_ID, actor.User_ID, "task_assigned", "New task assigned", task.Task_Title, "task", task.Task_ID);
  return task;
}

export function updateTask(
  db: BusinessDb,
  actor: User,
  taskId: string,
  patch: {
    Updated_At: string;
    Task_Title?: string;
    Description?: string;
    Assigned_To?: string;
    Priority?: Task["Priority"];
    Start_Date?: string;
    Due_Date?: string;
    Labels?: string;
    Severity?: Task["Severity"];
    Department?: string;
    Reviewer_ID?: string;
    Remarks?: string;
  },
) {
  const task = requireVisibleTask(db, actor, taskId);
  assertFresh(task.Updated_At, patch.Updated_At);
  const assigning = Boolean(patch.Assigned_To && patch.Assigned_To !== task.Assigned_To);
  const changingDetails = Boolean(
    (patch.Task_Title && patch.Task_Title !== task.Task_Title)
    || (patch.Description !== undefined && patch.Description !== task.Description)
    || (patch.Priority && patch.Priority !== task.Priority)
    || (patch.Start_Date !== undefined && patch.Start_Date !== task.Start_Date)
    || (patch.Due_Date && patch.Due_Date !== task.Due_Date)
    || (patch.Labels !== undefined && patch.Labels !== task.Labels)
    || (patch.Severity !== undefined && patch.Severity !== task.Severity)
    || (patch.Department && patch.Department !== task.Department)
    || (patch.Remarks !== undefined && patch.Remarks !== task.Remarks),
  );
  if (changingDetails && !canEditTaskMetadata(actor, task, db.users, db.scopes, db.members)) {
    throw new HttpError(403, "You cannot change the deadline, priority, or details of this task.");
  }
  if (!assigning && !changingDetails && !canEditTaskMetadata(actor, task, db.users, db.scopes, db.members)) {
    throw new HttpError(403, "You cannot change the deadline, priority, or details of this task.");
  }
  let genericChange = false;
  if (patch.Assigned_To && patch.Assigned_To !== task.Assigned_To) {
    const assignee = userById(db, patch.Assigned_To);
    if (assignee.Status !== "Active") throw new HttpError(400, "That employee is inactive.");
    if (!canAssignTo(actor, assignee.User_ID, db.users, db.scopes, db.members, task.Team_ID)) {
      throw new HttpError(403, "You cannot assign work to that employee.");
    }
    const previous = nameOf(db, task.Assigned_To);
    task.Assigned_To = assignee.User_ID;
    task.Assigned_By = actor.User_ID;
    ensureWorkflow(db, task).Reviewer_ID = actor.User_ID;
    if (!patch.Department) task.Department = assignee.Department;
    log(db, actor.User_ID, "task.assigned", "task", task.Task_ID, previous, assignee.Name);
    notify(db, assignee.User_ID, actor.User_ID, "task_assigned", "New task assigned", task.Task_Title, "task", task.Task_ID);
  }
  if (patch.Priority && patch.Priority !== task.Priority) {
    log(db, actor.User_ID, "task.priority", "task", task.Task_ID, task.Priority, patch.Priority);
    task.Priority = patch.Priority;
  }
  if (patch.Due_Date && patch.Due_Date !== task.Due_Date) {
    log(db, actor.User_ID, "task.deadline", "task", task.Task_ID, task.Due_Date, patch.Due_Date);
    task.Due_Date = patch.Due_Date;
  }
  if (patch.Task_Title && patch.Task_Title !== task.Task_Title) {
    task.Task_Title = patch.Task_Title;
    genericChange = true;
  }
  if (patch.Description !== undefined && patch.Description !== task.Description) {
    task.Description = patch.Description;
    genericChange = true;
  }
  if (patch.Start_Date !== undefined && patch.Start_Date !== task.Start_Date) {
    task.Start_Date = patch.Start_Date;
    genericChange = true;
  }
  if (patch.Labels !== undefined && patch.Labels !== task.Labels) {
    task.Labels = patch.Labels;
    genericChange = true;
  }
  if (patch.Severity !== undefined && patch.Severity !== task.Severity) {
    if (task.Type === "Bug" && !patch.Severity) throw new HttpError(400, "A bug needs a severity.");
    task.Severity = task.Type === "Bug" ? patch.Severity : "";
    genericChange = true;
  }
  if (patch.Department && patch.Department !== task.Department) {
    task.Department = patch.Department;
    genericChange = true;
  }
  if (patch.Remarks !== undefined && patch.Remarks !== task.Remarks) {
    task.Remarks = patch.Remarks;
    genericChange = true;
  }
  task.Updated_At = nowIso();
  if (genericChange) log(db, actor.User_ID, "task.updated", "task", task.Task_ID, "", task.Task_Title);
  return task;
}

function rejectTransition(message: string): never {
  const denied = /cannot|only an administrator/i.test(message);
  throw new HttpError(denied ? 403 : 400, message);
}

export function transitionTask(
  db: BusinessDb,
  actor: User,
  taskId: string,
  to: TaskStatus,
  reason: string,
  expectedUpdatedAt: string,
) {
  const task = requireVisibleTask(db, actor, taskId);
  assertFresh(task.Updated_At, expectedUpdatedAt);
  const workflow = ensureWorkflow(db, task);
  const message = transitionAllowed({ actor, task, workflow, users: db.users, scopes: db.scopes, members: db.members, to, reason });
  if (message) rejectTransition(message);
  const from = task.Status;
  task.Status = to;
  task.Updated_At = nowIso();
  if (to === "Blocked") workflow.Blocked_Reason = reason.trim();
  if (from === "Blocked" && to !== "Blocked") workflow.Blocked_Reason = "";
  if (to === "Completed") {
    task.Completed_At = task.Updated_At;
    log(db, actor.User_ID, "task.completed", "task", task.Task_ID, from, "Completed");
    notify(db, task.Assigned_To, actor.User_ID, "task_approved", "Task approved", task.Task_Title, "task", task.Task_ID);
  } else if (from === "Completed") {
    task.Completed_At = "";
    log(db, actor.User_ID, "task.status", "task", task.Task_ID, from, to);
  } else {
    log(db, actor.User_ID, "task.status", "task", task.Task_ID, from, to === "Blocked" ? `Blocked: ${reason.trim()}` : to);
  }
  if (to === "Under Review") {
    notify(
      db,
      effectiveReviewer(task, workflow),
      actor.User_ID,
      "submitted_for_review",
      "Task submitted for review",
      task.Task_Title,
      "task",
      task.Task_ID,
    );
  }
  if (from === "Under Review" && to === "In Progress") {
    workflow.Review_Note = reason.trim();
    db.comments.unshift({
      Comment_ID: nextId("C-", db.comments.map((item) => item.Comment_ID), 4),
      Task_ID: task.Task_ID,
      Author_ID: actor.User_ID,
      Body: `Returned: ${reason.trim()}`,
      Created_At: task.Updated_At,
    });
    notify(db, task.Assigned_To, actor.User_ID, "task_returned", "Task returned", task.Task_Title, "task", task.Task_ID);
  }
  return task;
}

export function addComment(db: BusinessDb, actor: User, taskId: string, body: string) {
  const task = requireVisibleTask(db, actor, taskId);
  const comment: Comment = {
    Comment_ID: nextId("C-", db.comments.map((item) => item.Comment_ID), 4),
    Task_ID: task.Task_ID,
    Author_ID: actor.User_ID,
    Body: body,
    Created_At: nowIso(),
  };
  db.comments.unshift(comment);
  task.Updated_At = comment.Created_At;
  for (const id of mentionIds(body)) {
    if (!db.users.some((user) => user.User_ID === id && user.Status === "Active")) continue;
    notify(db, id, actor.User_ID, "mentioned", `${actor.Name} mentioned you`, task.Task_Title, "task", task.Task_ID);
  }
  return comment;
}

export function addAttachment(
  db: BusinessDb,
  actor: User,
  taskId: string,
  file: { id?: string; name: string; mime: string; size: number; storage?: string },
) {
  const task = requireVisibleTask(db, actor, taskId);
  const id = file.id || nextId("A-", db.attachments.map((item) => item.Attachment_ID), 4);
  const attachment: Attachment = {
    Attachment_ID: id,
    Task_ID: task.Task_ID,
    File_Name: file.name,
    Mime_Type: file.mime,
    Size_Bytes: file.size,
    Uploaded_By: actor.User_ID,
    Uploaded_At: nowIso(),
    Storage_Ref: file.storage || id,
  };
  db.attachments.unshift(attachment);
  task.Updated_At = attachment.Uploaded_At;
  return attachment;
}

export function bulkUpdate(
  db: BusinessDb,
  actor: User,
  ids: string[],
  change: { Priority?: Task["Priority"]; to?: TaskStatus; reason: string },
) {
  if (!canBulkEdit(actor)) throw new HttpError(403, "You cannot update tasks in bulk.");
  const tasks = ids.map((id) => requireVisibleTask(db, actor, id));
  for (const task of tasks) {
    if (change.Priority && !canEditTaskMetadata(actor, task, db.users, db.scopes, db.members)) {
      throw new HttpError(403, `You cannot change the priority of ${task.Task_Title}.`);
    }
    if (change.to) {
      const message = transitionAllowed({
        actor,
        task,
        workflow: ensureWorkflow(db, task),
        users: db.users,
        scopes: db.scopes,
        members: db.members,
        to: change.to,
        reason: change.reason,
      });
      if (message) rejectTransition(`${task.Task_Title}: ${message}`);
    }
  }
  for (const task of tasks) {
    if (change.Priority && change.Priority !== task.Priority) {
      log(db, actor.User_ID, "task.priority", "task", task.Task_ID, task.Priority, change.Priority);
      task.Priority = change.Priority;
      task.Updated_At = nowIso();
    }
  }
  if (change.to) {
    for (const task of tasks) {
      transitionTask(db, actor, task.Task_ID, change.to, change.reason, task.Updated_At);
    }
  }
  return tasks;
}

function invitationStatus(db: BusinessDb, attendeeIds: string[], responses?: Record<string, InvitationStatus>) {
  const status: Record<string, InvitationStatus> = {};
  for (const id of attendeeIds) {
    const email = db.users.find((user) => user.User_ID === id)?.Email.toLowerCase();
    status[id] = (email && responses?.[email]) || "invited";
  }
  return status;
}

function applyGoogle(db: BusinessDb, meeting: Meeting, google?: GoogleEventLink | null) {
  if (!google) return;
  meeting.Calendar_Event_ID = google.eventId;
  meeting.Google_Meet_Link = google.meetLink;
  const detail = db.meetingDetails.find((item) => item.Meeting_ID === meeting.Meeting_ID);
  if (detail) {
    detail.Calendar_Link = google.htmlLink;
    detail.Invitation_Status = invitationStatus(db, meetingAttendeeIds(meeting), google.responses);
  }
}

export function createMeeting(
  db: BusinessDb,
  actor: User,
  input: {
    Meeting_Title: string;
    Description: string;
    Date: string;
    Start_Time: string;
    End_Time: string;
    Attendees: string[];
    Location: string;
    Format: "Online" | "In person";
    Reminder_Minutes: number;
  },
  google?: GoogleEventLink | null,
) {
  const attendeeIds = Array.from(new Set([actor.User_ID, ...input.Attendees]));
  for (const id of attendeeIds) {
    const person = userById(db, id);
    if (person.Status !== "Active") throw new HttpError(400, `${person.Name} is inactive and cannot be invited.`);
  }
  const stamp = nowIso();
  const meeting: Meeting = {
    Meeting_ID: nextId("M-", db.meetings.map((item) => item.Meeting_ID), 4),
    Meeting_Title: input.Meeting_Title,
    Description: input.Description,
    Organized_By: actor.User_ID,
    Attendees: joinIds(attendeeIds),
    Start_DateTime: kolkataToIso(input.Date, input.Start_Time),
    End_DateTime: kolkataToIso(input.Date, input.End_Time),
    Location: input.Location,
    Google_Meet_Link: "",
    Calendar_Event_ID: "",
    Status: "Scheduled",
    Created_At: stamp,
    Updated_At: stamp,
  };
  db.meetings.unshift(meeting);
  db.meetingDetails.push({
    Meeting_ID: meeting.Meeting_ID,
    Reminder_Minutes: input.Reminder_Minutes,
    Calendar_Link: "",
    Invitation_Status: invitationStatus(db, attendeeIds, google?.responses),
  });
  applyGoogle(db, meeting, google);
  if (input.Format === "In person") meeting.Google_Meet_Link = "";
  log(db, actor.User_ID, "meeting.created", "meeting", meeting.Meeting_ID, "", meeting.Meeting_Title);
  for (const id of attendeeIds) {
    const detailText = meeting.Google_Meet_Link ? `Join: ${meeting.Google_Meet_Link}` : "The time is blocked on the calendar.";
    notify(db, id, actor.User_ID, "meeting_invitation", meeting.Meeting_Title, detailText, "meeting", meeting.Meeting_ID);
  }
  return meeting;
}

export function updateMeeting(
  db: BusinessDb,
  actor: User,
  meetingId: string,
  input: {
    Updated_At: string;
    Meeting_Title: string;
    Description: string;
    Date: string;
    Start_Time: string;
    End_Time: string;
    Attendees: string[];
    Location: string;
    Format: "Online" | "In person";
    Reminder_Minutes: number;
  },
  google?: GoogleEventLink | null,
) {
  const meeting = meetingById(db, meetingId);
  if (!canViewMeeting(actor, meeting, db.users, db.scopes, db.members)) throw new HttpError(403, "You cannot view this meeting.");
  if (!canManageMeeting(actor, meeting, db)) throw new HttpError(403, "You cannot change this meeting.");
  if (meeting.Status === "Cancelled") throw new HttpError(400, "Cancelled meetings cannot be edited.");
  assertFresh(meeting.Updated_At, input.Updated_At);
  const attendeeIds = Array.from(new Set([meeting.Organized_By, ...input.Attendees]));
  for (const id of attendeeIds) {
    const person = userById(db, id);
    if (person.Status !== "Active" && !meetingAttendeeIds(meeting).includes(id)) {
      throw new HttpError(400, `${person.Name} is inactive and cannot be invited.`);
    }
  }
  const nextStart = kolkataToIso(input.Date, input.Start_Time);
  const nextEnd = kolkataToIso(input.Date, input.End_Time);
  const moved = nextStart !== meeting.Start_DateTime || nextEnd !== meeting.End_DateTime;
  const previous = `${meeting.Start_DateTime} → ${meeting.End_DateTime}`;
  meeting.Meeting_Title = input.Meeting_Title;
  meeting.Description = input.Description;
  meeting.Attendees = joinIds(attendeeIds);
  meeting.Location = input.Location;
  meeting.Start_DateTime = nextStart;
  meeting.End_DateTime = nextEnd;
  meeting.Updated_At = nowIso();
  const detail = db.meetingDetails.find((item) => item.Meeting_ID === meeting.Meeting_ID);
  if (detail) detail.Reminder_Minutes = input.Reminder_Minutes;
  applyGoogle(db, meeting, google);
  if (input.Format === "In person") meeting.Google_Meet_Link = "";
  if (moved) {
    log(db, actor.User_ID, "meeting.rescheduled", "meeting", meeting.Meeting_ID, previous, `${nextStart} → ${nextEnd}`);
    for (const id of attendeeIds) {
      notify(db, id, actor.User_ID, "meeting_rescheduled", meeting.Meeting_Title, "The meeting time has changed.", "meeting", meeting.Meeting_ID);
    }
  }
  return meeting;
}

export function cancelMeeting(db: BusinessDb, actor: User, meetingId: string, expectedUpdatedAt: string) {
  const meeting = meetingById(db, meetingId);
  if (!canManageMeeting(actor, meeting, db)) throw new HttpError(403, "You cannot cancel this meeting.");
  assertFresh(meeting.Updated_At, expectedUpdatedAt);
  if (meeting.Status === "Cancelled") return meeting;
  meeting.Status = "Cancelled";
  meeting.Updated_At = nowIso();
  log(db, actor.User_ID, "meeting.cancelled", "meeting", meeting.Meeting_ID, "Scheduled", "Cancelled");
  for (const id of meetingAttendeeIds(meeting)) {
    notify(db, id, actor.User_ID, "meeting_cancelled", meeting.Meeting_Title, "The meeting was cancelled.", "meeting", meeting.Meeting_ID);
  }
  return meeting;
}

export function respondMeeting(db: BusinessDb, actor: User, meetingId: string, response: "accepted" | "declined" | "tentative") {
  const meeting = meetingById(db, meetingId);
  if (!canViewMeeting(actor, meeting, db.users, db.scopes, db.members)) throw new HttpError(403, "You cannot view this meeting.");
  if (meeting.Status === "Cancelled") throw new HttpError(400, "This meeting is cancelled.");
  if (actor.User_ID === meeting.Organized_By) throw new HttpError(400, "The organizer does not respond to their own meeting.");
  if (!meetingAttendeeIds(meeting).includes(actor.User_ID)) throw new HttpError(403, "You are not invited to this meeting.");
  const detail = db.meetingDetails.find((item) => item.Meeting_ID === meeting.Meeting_ID);
  if (!detail) throw new HttpError(404, "Meeting not found.");
  detail.Invitation_Status = { ...detail.Invitation_Status, [actor.User_ID]: response };
  meeting.Updated_At = nowIso();
  const phrase = response === "declined" ? "rejected this meeting" : response === "tentative" ? "wants to postpone this meeting" : "accepted this meeting";
  notify(db, meeting.Organized_By, actor.User_ID, "meeting_invitation", meeting.Meeting_Title, `${actor.Name} ${phrase}.`, "meeting", meeting.Meeting_ID);
  return meeting;
}

export function syncMeeting(db: BusinessDb, actor: User, meetingId: string, google: GoogleEventLink & { status?: string; start?: string; end?: string; location?: string }) {
  const meeting = meetingById(db, meetingId);
  if (!canViewMeeting(actor, meeting, db.users, db.scopes, db.members)) throw new HttpError(403, "You cannot view this meeting.");
  if (google.status === "cancelled") {
    meeting.Status = "Cancelled";
  }
  if (google.start && google.end && (google.start !== meeting.Start_DateTime || google.end !== meeting.End_DateTime)) {
    const previous = `${meeting.Start_DateTime} → ${meeting.End_DateTime}`;
    meeting.Start_DateTime = new Date(google.start).toISOString();
    meeting.End_DateTime = new Date(google.end).toISOString();
    log(db, actor.User_ID, "meeting.rescheduled", "meeting", meeting.Meeting_ID, previous, `${meeting.Start_DateTime} → ${meeting.End_DateTime}`);
  }
  if (google.location) meeting.Location = google.location;
  meeting.Updated_At = nowIso();
  applyGoogle(db, meeting, google);
  return meeting;
}

export function knownBusy(db: BusinessDb, userId: string) {
  const windows: Array<{ start: string; end: string }> = [];
  for (const meeting of db.meetings) {
    if (meeting.Status !== "Scheduled") continue;
    if (!meetingAttendeeIds(meeting).includes(userId)) continue;
    windows.push({ start: meeting.Start_DateTime, end: meeting.End_DateTime });
  }
  for (const busy of db.busy) {
    if (busy.User_ID === userId) windows.push({ start: busy.Start, end: busy.End });
  }
  return windows;
}

export function availabilityFor(
  db: BusinessDb,
  attendeeIds: string[],
  rangeStart: string,
  rangeEnd: string,
  externalByEmail: Record<string, ExternalCalendar>,
) {
  return attendeeIds.map((id) => {
    const person = userById(db, id);
    const internal = knownBusy(db, id).filter((item) => overlaps(item.start, item.end, rangeStart, rangeEnd));
    const external = externalByEmail[person.Email.toLowerCase()] ?? { state: "unknown" as const };
    return { ...mergeAvailability({ userId: id, rangeStart, rangeEnd, internal, external }), name: person.Name };
  });
}

export function slotsFor(
  db: BusinessDb,
  attendeeIds: string[],
  day: string,
  durationMinutes: number,
  externalBusy: Array<{ start: string; end: string }>,
  confirmed: boolean,
) {
  for (const id of attendeeIds) userById(db, id);
  const busy = [...externalBusy];
  for (const id of attendeeIds) busy.push(...knownBusy(db, id));
  return findSlots({
    day,
    durationMinutes,
    workStart: setting(db, "workday_start", "09:30"),
    workEnd: setting(db, "workday_end", "18:30"),
    workdays: workdays(db),
    busy,
    confirmed,
  });
}

function assertNoCycle(db: BusinessDb, userId: string, managers: string[]) {
  if (managers.includes(userId)) throw new HttpError(400, "An employee cannot report to themselves.");
  const descendants = descendantIds(db.users, userId);
  if (managers.some((id) => descendants.has(id))) {
    throw new HttpError(400, "That reporting line would create a cycle.");
  }
  for (const id of managers) userById(db, id);
}

function replaceScopes(db: BusinessDb, userId: string, role: User["Access_Role"], departments: string[]) {
  db.scopes = db.scopes.filter((scope) => scope.User_ID !== userId);
  if (role !== "Coordinator") return;
  for (const department of Array.from(new Set(departments.map((item) => item.trim()).filter(Boolean)))) {
    db.scopes.push({ User_ID: userId, Scope_Type: "department", Scope_Value: department });
  }
}

function assertAdminRemains(db: BusinessDb, userId: string, next: Pick<User, "Status" | "Access_Role">) {
  const remaining = db.users.filter((user) => {
    if (user.User_ID === userId) return next.Status === "Active" && next.Access_Role === "Admin";
    return user.Status === "Active" && user.Access_Role === "Admin";
  }).length;
  if (remaining < 1) throw new HttpError(400, "The organisation needs at least one active administrator.");
}

export function saveUser(
  db: BusinessDb,
  actor: User,
  input: {
    User_ID?: string;
    Name: string;
    Email: string;
    Department: string;
    Role: string;
    Reports_To: string[];
    Status: User["Status"];
    Access_Role: User["Access_Role"];
    Scopes: string[];
  },
) {
  if (!canManageUsers(actor)) throw new HttpError(403, "Only an administrator can change employee access.");
  const email = input.Email.toLowerCase();
  const duplicate = db.users.find((user) => user.Email.toLowerCase() === email && user.User_ID !== input.User_ID);
  if (duplicate) throw new HttpError(400, "Another employee already uses that email.");
  if (input.User_ID) {
    const user = userById(db, input.User_ID);
    if (user.User_ID === actor.User_ID && input.Status === "Inactive") {
      throw new HttpError(400, "You cannot deactivate your own account.");
    }
    assertAdminRemains(db, user.User_ID, input);
    assertNoCycle(db, user.User_ID, input.Reports_To);
    const previousRole = user.Access_Role;
    const previousStatus = user.Status;
    user.Name = input.Name;
    user.Email = email;
    user.Department = input.Department;
    user.Role = input.Role;
    user.Reports_To = joinIds(input.Reports_To);
    user.Status = input.Status;
    if (input.Status === "Inactive") {
      for (const membership of db.members) {
        if (membership.User_ID === user.User_ID) membership.Status = "Inactive";
      }
    }
    user.Access_Role = input.Access_Role;
    replaceScopes(db, user.User_ID, input.Access_Role, input.Scopes);
    if (previousRole !== input.Access_Role || previousStatus !== input.Status) {
      log(db, actor.User_ID, "user.access", "user", user.User_ID, previousRole, input.Access_Role);
    } else {
      log(db, actor.User_ID, "user.updated", "user", user.User_ID, "", user.Name);
    }
    return user;
  }
  const user: User = {
    User_ID: nextId("U-", db.users.map((item) => item.User_ID), 3),
    Name: input.Name,
    Email: email,
    Department: input.Department,
    Role: input.Role,
    Reports_To: joinIds(input.Reports_To),
    Status: input.Status,
    Access_Role: input.Access_Role,
  };
  db.users.push(user);
  assertNoCycle(db, user.User_ID, input.Reports_To);
  assertAdminRemains(db, user.User_ID, user);
  replaceScopes(db, user.User_ID, user.Access_Role, input.Scopes);
  log(db, actor.User_ID, "user.updated", "user", user.User_ID, "", user.Name);
  return user;
}

export function renameSelf(db: BusinessDb, actor: User, name: string) {
  const cleaned = name.trim().replace(/\s+/g, " ");
  if (cleaned.length < 2 || cleaned.length > 80) throw new HttpError(400, "Enter the name people should see.");
  if (/[\[\]@()]/.test(cleaned)) throw new HttpError(400, "The profile name cannot include @, brackets, or parentheses.");
  const taken = db.users.find((user) => user.User_ID !== actor.User_ID && user.Status === "Active" && user.Name.toLowerCase() === cleaned.toLowerCase());
  if (taken) throw new HttpError(400, "That profile name is already used. Choose one people can tag uniquely.");
  const user = userById(db, actor.User_ID);
  if (user.Status !== "Active") throw new HttpError(403, "This account is inactive.");
  if (user.Name === cleaned) return user;
  const previous = user.Name;
  user.Name = cleaned;
  log(db, actor.User_ID, "user.renamed", "user", user.User_ID, previous, cleaned);
  return user;
}

export function updateSettings(db: BusinessDb, actor: User, input: { workday_start: string; workday_end: string; workdays: number[] }) {
  if (!canManageUsers(actor)) throw new HttpError(403, "Only an administrator can change working hours.");
  if (input.workday_end <= input.workday_start) throw new HttpError(400, "The working day must end after it starts.");
  const write = (key: string, value: string) => {
    const row = db.settings.find((item) => item.Key === key);
    if (row) row.Value = value;
    else db.settings.push({ Key: key, Value: value, Description: key });
  };
  write("workday_start", input.workday_start);
  write("workday_end", input.workday_end);
  write("workdays", input.workdays.join(","));
}

const emptyFile = { File_Name: "", Mime_Type: "", Size_Bytes: 0, Storage_Ref: "" };

export function postWorkspaceMessage(
  db: BusinessDb,
  actor: User,
  teamId: string,
  body: string,
  file: { File_Name: string; Mime_Type: string; Size_Bytes: number; Storage_Ref: string } = emptyFile,
) {
  if (!hasWorkspaceAccess(db, actor)) throw new HttpError(403, "Accept an invite before opening the workspace.");
  const team = db.teams.find((item) => item.Team_ID === teamId && item.Status === "Active");
  if (!team) throw new HttpError(404, "That workspace was not found.");
  if (actor.Access_Role !== "Admin" && !onTeam(db.members, actor.User_ID, team.Team_ID)) {
    throw new HttpError(403, "Join this workspace before sending a message.");
  }
  const text = body.trim();
  if (!text && !file.Storage_Ref) throw new HttpError(400, "Write a message or attach a file.");
  const message = {
    Message_ID: nextId("MSG-", (db.messages ?? []).map((item) => item.Message_ID), 4),
    Team_ID: team.Team_ID,
    Recipient_ID: "",
    Author_ID: actor.User_ID,
    Body: text.slice(0, 4000),
    File_Name: file.File_Name.slice(0, 180),
    Mime_Type: file.Mime_Type.slice(0, 120),
    Size_Bytes: file.Size_Bytes,
    Storage_Ref: file.Storage_Ref,
    Created_At: nowIso(),
  };
  db.messages = db.messages ?? [];
  db.messages.push(message);
  const preview = text.replace(/@\[([^\]]+)\]\([^)]+\)/g, "@$1");
  for (const id of mentionIds(text)) {
    if (!onTeam(db.members, id, team.Team_ID)) continue;
    if (!db.users.some((user) => user.User_ID === id && user.Status === "Active")) continue;
    notify(db, id, actor.User_ID, "mentioned", `${actor.Name} mentioned you in ${team.Name}`, preview.slice(0, 140), "team", team.Team_ID);
  }
  return message;
}

export function postDirectMessage(
  db: BusinessDb,
  actor: User,
  recipientId: string,
  body: string,
  file: { File_Name: string; Mime_Type: string; Size_Bytes: number; Storage_Ref: string } = emptyFile,
) {
  if (!hasWorkspaceAccess(db, actor)) throw new HttpError(403, "Accept an invite before sending a message.");
  if (recipientId === actor.User_ID) throw new HttpError(400, "Choose another person.");
  const recipient = db.users.find((user) => user.User_ID === recipientId && user.Status === "Active");
  if (!recipient) throw new HttpError(404, "That person is not in the directory.");
  const text = body.trim();
  if (!text && !file.Storage_Ref) throw new HttpError(400, "Write a message or attach a file.");
  const message = {
    Message_ID: nextId("MSG-", (db.messages ?? []).map((item) => item.Message_ID), 4),
    Team_ID: "",
    Recipient_ID: recipient.User_ID,
    Author_ID: actor.User_ID,
    Body: text.slice(0, 4000),
    File_Name: file.File_Name.slice(0, 180),
    Mime_Type: file.Mime_Type.slice(0, 120),
    Size_Bytes: file.Size_Bytes,
    Storage_Ref: file.Storage_Ref,
    Created_At: nowIso(),
  };
  db.messages = db.messages ?? [];
  db.messages.push(message);
  notify(db, recipient.User_ID, actor.User_ID, "direct_message", `Message from ${actor.Name}`, (text || file.File_Name).slice(0, 140), "user", actor.User_ID);
  return message;
}

export function createTeam(db: BusinessDb, actor: User, input: { Name: string; Description: string }) {
  if (!hasWorkspaceAccess(db, actor)) throw new HttpError(403, "Accept an invite before creating a group.");
  const name = input.Name.trim();
  if (db.teams.some((team) => team.Status === "Active" && team.Name.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(400, "A group already uses that name.");
  }
  const team = { Team_ID: nextId("TM-", db.teams.map((item) => item.Team_ID), 3), Name: name, Description: input.Description, Status: "Active" as const, Created_At: nowIso() };
  db.teams.unshift(team);
  db.members.push({ Team_ID: team.Team_ID, User_ID: actor.User_ID, Member_Role: "Lead", Status: "Active", Joined_At: nowIso() });
  log(db, actor.User_ID, "team.created", "team", team.Team_ID, "", team.Name);
  return team;
}

export function createProject(db: BusinessDb, actor: User, input: { Team_ID: string; Name: string; Key: string }) {
  if (!hasWorkspaceAccess(db, actor)) throw new HttpError(403, "Accept an invite before opening the workspace.");
  const team = db.teams.find((item) => item.Team_ID === input.Team_ID && item.Status === "Active");
  if (!team) throw new HttpError(400, "Choose an active team.");
  const lead = db.members.some((member) => member.Team_ID === team.Team_ID && member.User_ID === actor.User_ID && member.Status === "Active" && member.Member_Role === "Lead");
  if (actor.Access_Role !== "Admin" && !lead) throw new HttpError(403, "Only an administrator or a team lead can add a project.");
  const key = input.Key.toUpperCase();
  if (db.projects.some((project) => project.Key.toLowerCase() === key.toLowerCase())) throw new HttpError(400, "That project key is already used.");
  const project = { Project_ID: nextId("P-", db.projects.map((item) => item.Project_ID), 3), Team_ID: team.Team_ID, Name: input.Name.trim(), Key: key, Next_Number: 1, Status: "Active" as const };
  db.projects.unshift(project);
  log(db, actor.User_ID, "project.created", "team", team.Team_ID, "", `${project.Key} ${project.Name}`);
  return project;
}

export function createInvite(db: BusinessDb, actor: User, input: { Email: string; Team_ID: string; Access_Role: User["Access_Role"]; Member_Role: "Lead" | "Member" }) {
  if (!hasWorkspaceAccess(db, actor)) throw new HttpError(403, "Accept an invite before opening the workspace.");
  const team = db.teams.find((item) => item.Team_ID === input.Team_ID && item.Status === "Active");
  if (!team) throw new HttpError(400, "Choose an active team.");
  if (!canInviteToTeam(actor, team.Team_ID, db.members)) throw new HttpError(403, "You cannot invite people to that team.");
  if (input.Access_Role === "Admin" && actor.Access_Role !== "Admin") throw new HttpError(403, "Only an administrator can invite an administrator.");
  const email = input.Email.toLowerCase();
  if (isPlaceholderEmail(email)) throw new HttpError(400, "Invite a real email address.");
  const existingUser = db.users.find((user) => user.Email.toLowerCase() === email);
  if (existingUser && onTeam(db.members, existingUser.User_ID, team.Team_ID)) throw new HttpError(400, "That person is already in this group.");
  if (db.invites.some((invite) => invite.Email.toLowerCase() === email && invite.Team_ID === team.Team_ID && invite.Status === "Pending")) {
    throw new HttpError(400, "That person already has a pending invite to this team.");
  }
  const invite = {
    Invite_ID: nextId("I-", db.invites.map((item) => item.Invite_ID), 4),
    Email: email,
    Team_ID: team.Team_ID,
    Access_Role: input.Access_Role,
    Member_Role: input.Member_Role,
    Invited_By: actor.User_ID,
    Status: "Pending" as const,
    Created_At: nowIso(),
    Responded_At: "",
  };
  db.invites.unshift(invite);
  log(db, actor.User_ID, "invite.sent", "team", team.Team_ID, "", email);
  if (existingUser) notify(db, existingUser.User_ID, actor.User_ID, "invited", `Invitation to ${team.Name}`, `${actor.Name} invited you to ${team.Name}. Accept it to join.`, "team", team.Team_ID);
  return invite;
}

export function addTeamMember(db: BusinessDb, actor: User, teamId: string, userId: string, memberRole: "Lead" | "Member") {
  if (!hasWorkspaceAccess(db, actor)) throw new HttpError(403, "Accept an invite before opening the workspace.");
  const team = db.teams.find((item) => item.Team_ID === teamId && item.Status === "Active");
  if (!team) throw new HttpError(404, "That group was not found.");
  if (!canInviteToTeam(actor, team.Team_ID, db.members)) throw new HttpError(403, "You cannot add people to that group.");
  const person = db.users.find((user) => user.User_ID === userId && user.Status === "Active");
  if (!person) throw new HttpError(404, "That person is not in the directory.");
  if (onTeam(db.members, person.User_ID, team.Team_ID)) throw new HttpError(400, "That person is already in this group.");
  const current = db.members.find((member) => member.Team_ID === team.Team_ID && member.User_ID === person.User_ID);
  const joined = nowIso();
  if (current) {
    current.Status = "Active";
    current.Member_Role = memberRole;
    current.Joined_At = joined;
  } else {
    db.members.push({ Team_ID: team.Team_ID, User_ID: person.User_ID, Member_Role: memberRole, Status: "Active", Joined_At: joined });
  }
  notify(db, person.User_ID, actor.User_ID, "invited", `Added to ${team.Name}`, `${actor.Name} added you to ${team.Name}.`, "team", team.Team_ID);
  log(db, actor.User_ID, "team.member_added", "team", team.Team_ID, "", person.Name);
  return current ?? db.members[db.members.length - 1];
}

export function revokeInvite(db: BusinessDb, actor: User, inviteId: string) {
  const invite = db.invites.find((item) => item.Invite_ID === inviteId);
  if (!invite || invite.Status !== "Pending") throw new HttpError(404, "That invite is no longer pending.");
  if (!canInviteToTeam(actor, invite.Team_ID, db.members)) throw new HttpError(403, "You cannot revoke that invite.");
  invite.Status = "Revoked";
  invite.Responded_At = nowIso();
  log(db, actor.User_ID, "invite.revoked", "team", invite.Team_ID, invite.Email, "Revoked");
  return invite;
}

export function respondInvite(db: BusinessDb, actor: User, inviteId: string, accept: boolean) {
  const invite = db.invites.find((item) => item.Invite_ID === inviteId);
  if (!invite || invite.Status !== "Pending") throw new HttpError(404, "That invite is no longer pending.");
  if (invite.Email.toLowerCase() !== actor.Email.toLowerCase()) throw new HttpError(403, "This invite was sent to a different email.");
  if (actor.Status !== "Active") throw new HttpError(403, "This account is inactive.");
  invite.Status = accept ? "Accepted" : "Declined";
  invite.Responded_At = nowIso();
  if (!accept) {
    log(db, actor.User_ID, "invite.declined", "team", invite.Team_ID, "", actor.Email);
    return invite;
  }
  const current = db.members.find((member) => member.Team_ID === invite.Team_ID && member.User_ID === actor.User_ID);
  if (current) {
    current.Status = "Active";
    current.Member_Role = invite.Member_Role;
    current.Joined_At = invite.Responded_At;
  } else {
    db.members.push({ Team_ID: invite.Team_ID, User_ID: actor.User_ID, Member_Role: invite.Member_Role, Status: "Active", Joined_At: invite.Responded_At });
  }
  actor.Access_Role = higherRole(actor.Access_Role, invite.Access_Role);
  const stored = userById(db, actor.User_ID);
  stored.Access_Role = actor.Access_Role;
  log(db, actor.User_ID, "invite.accepted", "team", invite.Team_ID, "", stored.Name);
  return invite;
}

export function ensureAccount(db: BusinessDb, profile: { email: string; name: string }, bootstrapEmail: string) {
  const email = profile.email.toLowerCase();
  let user = db.users.find((item) => item.Email.toLowerCase() === email);
  const bootstrap = bootstrapEmail.trim().toLowerCase();
  const noAdmin = !db.users.some((item) => item.Status === "Active" && item.Access_Role === "Admin");
  const becomesAdmin = Boolean(bootstrap) && email === bootstrap && noAdmin;
  if (!user) {
    user = {
      User_ID: nextId("U-", db.users.map((item) => item.User_ID), 3),
      Name: accountName(profile.name, email),
      Email: email,
      Department: "",
      Role: "",
      Reports_To: "",
      Status: "Active",
      Access_Role: becomesAdmin ? "Admin" : "Employee",
    };
    db.users.push(user);
    log(db, user.User_ID, "user.created", "user", user.User_ID, "", user.Name);
  } else if (becomesAdmin) {
    user.Access_Role = "Admin";
    user.Status = "Active";
  }
  if (user.Status !== "Active") throw new HttpError(403, "This account is inactive. Ask an administrator to restore access.");
  return user;
}

function accountName(name: string, email: string) {
  const cleaned = name.trim().replace(/\s+/g, " ").replace(/[\[\]@()]/g, "");
  if (cleaned.length >= 2) return cleaned.slice(0, 80);
  const local = email.split("@")[0]?.replace(/[._-]+/g, " ").replace(/[^a-zA-Z0-9 ]/g, "").trim() || "New member";
  return local.length >= 2 ? local.slice(0, 80) : "New member";
}

export function markNotifications(db: BusinessDb, actor: User, ids: string[] | "all") {
  const stamp = nowIso();
  for (const item of db.notifications) {
    if (item.Recipient_ID !== actor.User_ID || item.Read_At) continue;
    if (ids === "all" || ids.includes(item.Notification_ID)) item.Read_At = stamp;
  }
}

export function placeholderAttendees(db: BusinessDb, ids: string[]) {
  return ids
    .map((id) => db.users.find((user) => user.User_ID === id))
    .filter((user): user is User => Boolean(user?.Email.toLowerCase().endsWith("@goyal.demo")))
    .map((user) => user.Name);
}
