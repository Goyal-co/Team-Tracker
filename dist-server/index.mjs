// server/index.ts
import fs4 from "node:fs";
import path5 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { Redis } from "ioredis";
import pg from "pg";

// server/config.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
var root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function loadConfig() {
  const production = process.env.NODE_ENV === "production";
  const sessionSecret = process.env.SESSION_SECRET || (production ? "" : "dev-only-secret-change-me");
  if (!sessionSecret || sessionSecret.length < 16) {
    throw new Error("Set SESSION_SECRET to a random string of at least 16 characters.");
  }
  const bootstrapAdminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() ?? "";
  if (production && !bootstrapAdminEmail) {
    throw new Error("Set BOOTSTRAP_ADMIN_EMAIL to the Google account that should become the first administrator.");
  }
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  const redisUrl = process.env.REDIS_URL?.trim() ?? "";
  if (!databaseUrl) throw new Error("Set DATABASE_URL.");
  return {
    production,
    sessionSecret,
    bootstrapAdminEmail,
    googleClientId: process.env.GOOGLE_CLIENT_ID?.trim() ?? "",
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "",
    googleRedirectUri: process.env.GOOGLE_REDIRECT_URI?.trim() || "https://localhost:5174/api/google/calendar/callback",
    databaseUrl,
    redisUrl,
    port: Number(process.env.PORT || 5175),
    dataDir: process.env.DATA_DIR || path.join(root, "data"),
    cookieSecure: process.env.COOKIE_SECURE === "true",
    trustProxy: process.env.TRUST_PROXY === "true",
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY?.trim() ?? "",
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY?.trim() ?? "",
    vapidSubject: process.env.VAPID_SUBJECT?.trim() || "mailto:admin@localhost"
  };
}
function systemInfo(config, dataStore) {
  return {
    googleClientId: config.googleClientId,
    calendarOAuthReady: Boolean(config.googleClientId && config.googleClientSecret && config.googleRedirectUri),
    dataStore,
    bootstrapConfigured: Boolean(config.bootstrapAdminEmail),
    pushReady: Boolean(config.vapidPublicKey && config.vapidPrivateKey)
  };
}

// server/app.ts
import fs2 from "node:fs";
import path3 from "node:path";
import { createHash, createHmac, randomBytes as randomBytes2, timingSafeEqual } from "node:crypto";
import express from "express";
import { ZodError } from "zod";

// src/domain/dates.ts
var TIMEZONE = "Asia/Kolkata";
function kolkataParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return { year: get("year"), month: get("month"), day: get("day"), hour, minute: get("minute") };
}
function kolkataToday(now = /* @__PURE__ */ new Date()) {
  const parts = kolkataParts(now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function addDays(ymd, days) {
  const [year, month, day2] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day2));
  date.setUTCDate(date.getUTCDate() + days);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function kolkataToIso(ymd, time) {
  const [year, month, day2] = ymd.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const utc = Date.UTC(year, month - 1, day2, hour, minute) - (5 * 60 + 30) * 60 * 1e3;
  return new Date(utc).toISOString();
}
function isOverdue(task, today = kolkataToday()) {
  return task.Status !== "Completed" && Boolean(task.Due_Date) && task.Due_Date < today;
}

// src/domain/availability.ts
function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}
function clip(start, end, rangeStart, rangeEnd) {
  const clippedStart = start > rangeStart ? start : rangeStart;
  const clippedEnd = end < rangeEnd ? end : rangeEnd;
  if (clippedStart >= clippedEnd) return null;
  return { start: clippedStart, end: clippedEnd };
}
function mergeAvailability(input) {
  const windows = [];
  for (const item of input.internal) {
    const clipped = clip(item.start, item.end, input.rangeStart, input.rangeEnd);
    if (clipped) windows.push({ ...clipped, source: "internal" });
  }
  if (input.external.state === "busy") {
    for (const item of input.external.windows) {
      const clipped = clip(item.start, item.end, input.rangeStart, input.rangeEnd);
      if (clipped) windows.push({ ...clipped, source: "google" });
    }
  }
  if (windows.length) return { userId: input.userId, state: "busy", windows };
  if (input.external.state === "unknown") return { userId: input.userId, state: "unknown", windows: [] };
  return { userId: input.userId, state: "available", windows: [] };
}
function findSlots(input) {
  const weekday = (/* @__PURE__ */ new Date(`${input.day}T00:00:00Z`)).getUTCDay();
  if (!input.workdays.includes(weekday)) return [];
  const [year, month, day2] = input.day.split("-").map(Number);
  const [startHour, startMinute] = input.workStart.split(":").map(Number);
  const [endHour, endMinute] = input.workEnd.split(":").map(Number);
  const dayStartUtc = Date.UTC(year, month - 1, day2, startHour, startMinute) - (5 * 60 + 30) * 60 * 1e3;
  const dayEndUtc = Date.UTC(year, month - 1, day2, endHour, endMinute) - (5 * 60 + 30) * 60 * 1e3;
  const step = 30 * 60 * 1e3;
  const duration = input.durationMinutes * 60 * 1e3;
  const slots = [];
  for (let cursor = dayStartUtc; cursor + duration <= dayEndUtc; cursor += step) {
    const start = new Date(cursor).toISOString();
    const end = new Date(cursor + duration).toISOString();
    const blocked = input.busy.some((item) => overlaps(start, end, item.start, item.end));
    if (!blocked) slots.push({ start, end, confirmed: input.confirmed });
    if (slots.length >= (input.limit ?? 6)) break;
  }
  return slots;
}
function interpretGoogleEntry(entry) {
  if (!entry || entry.errors && entry.errors.length > 0) return { state: "unknown" };
  const windows = (entry.busy ?? []).map((item) => ({ start: new Date(item.start).toISOString(), end: new Date(item.end).toISOString() })).filter((item) => item.start !== "Invalid Date" && !Number.isNaN(new Date(item.start).getTime()));
  if (windows.length) return { state: "busy", windows };
  return { state: "available" };
}

// src/domain/schemas.ts
import { z } from "zod";

// src/domain/types.ts
var TASK_STATUSES = ["To Do", "In Progress", "Under Review", "Blocked", "Completed"];
var PRIORITIES = ["Low", "Medium", "High", "Urgent"];
var ACCESS_ROLES = ["Admin", "Manager", "Coordinator", "Employee"];
var WORK_TYPES = ["Task", "Bug", "Feature"];
var SEVERITIES = ["Critical", "High", "Medium", "Low"];
var MEMBER_ROLES = ["Lead", "Member"];

// src/domain/ids.ts
function nextId(prefix, existing, width) {
  let max = 0;
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  for (const value of existing) {
    const match = pattern.exec(value);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}${String(max + 1).padStart(width, "0")}`;
}
function splitIds(value) {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}
function joinIds(ids) {
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).join(",");
}
function isPlaceholderEmail(email) {
  return email.trim().toLowerCase().endsWith("@goyal.demo");
}
function cleanText(value) {
  return value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

// src/domain/schemas.ts
var day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.");
var text = (max) => z.string().transform(cleanText).pipe(z.string().max(max));
var createTaskSchema = z.object({
  Task_Title: text(180).pipe(z.string().min(1, "Task title is required.")),
  Description: text(5e3).optional().default(""),
  Assigned_To: z.string().min(1, "Choose an employee."),
  Priority: z.enum(PRIORITIES),
  Start_Date: z.union([day, z.literal("")]).optional().default(""),
  Due_Date: day,
  Team_ID: z.string().min(1, "Choose a team."),
  Project_ID: z.string().min(1, "Choose a project."),
  Type: z.enum(WORK_TYPES),
  Severity: z.enum(SEVERITIES).or(z.literal("")).optional().default(""),
  Labels: text(200).optional().default(""),
  Department: text(80).optional().default(""),
  Reviewer_ID: z.string().optional().default(""),
  Remarks: text(2e3).optional().default(""),
  CC_User_Ids: z.array(z.string().min(1)).optional().default([])
}).superRefine((value, ctx) => {
  if (value.Start_Date && value.Due_Date < value.Start_Date) {
    ctx.addIssue({ code: "custom", message: "Due date cannot be before the start date.", path: ["Due_Date"] });
  }
  if (value.Type === "Bug" && !value.Severity) {
    ctx.addIssue({ code: "custom", message: "A bug needs a severity.", path: ["Severity"] });
  }
});
var updateTaskSchema = z.object({
  Updated_At: z.string().min(1),
  Task_Title: text(180).pipe(z.string().min(1)).optional(),
  Description: text(5e3).optional(),
  Assigned_To: z.string().min(1).optional(),
  Priority: z.enum(PRIORITIES).optional(),
  Start_Date: z.union([day, z.literal("")]).optional(),
  Due_Date: day.optional(),
  Labels: text(200).optional(),
  Severity: z.enum(SEVERITIES).or(z.literal("")).optional(),
  Department: text(80).optional(),
  Reviewer_ID: z.string().optional(),
  Remarks: text(2e3).optional(),
  CC_User_Ids: z.array(z.string().min(1)).optional()
}).superRefine((value, ctx) => {
  if (value.Start_Date && value.Due_Date && value.Due_Date < value.Start_Date) {
    ctx.addIssue({ code: "custom", message: "Due date cannot be before the start date.", path: ["Due_Date"] });
  }
});
var transitionSchema = z.object({
  Updated_At: z.string().min(1),
  to: z.enum(TASK_STATUSES),
  reason: text(1e3).optional().default("")
});
var commentSchema = z.object({
  Body: text(2e3).pipe(z.string().min(1, "Write a comment before sending."))
});
var bulkSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
  Priority: z.enum(PRIORITIES).optional(),
  to: z.enum(TASK_STATUSES).optional(),
  reason: text(1e3).optional().default("")
});
var meetingSchema = z.object({
  Meeting_Title: text(180).pipe(z.string().min(1, "Meeting title is required.")),
  Description: text(5e3).optional().default(""),
  Date: day,
  Start_Time: z.string().regex(/^\d{2}:\d{2}$/),
  End_Time: z.string().regex(/^\d{2}:\d{2}$/),
  Attendees: z.array(z.string()).default([]),
  Location: text(180).optional().default(""),
  Format: z.enum(["Online", "In person"]),
  Reminder_Minutes: z.number().int().min(0).max(10080).optional().default(10),
  Updated_At: z.string().optional()
}).superRefine((value, ctx) => {
  if (value.End_Time <= value.Start_Time) {
    ctx.addIssue({ code: "custom", message: "End time must be after the start time.", path: ["End_Time"] });
  }
  if (value.Format === "In person" && !value.Location.trim()) {
    ctx.addIssue({ code: "custom", message: "Add the place where people should meet.", path: ["Location"] });
  }
});
var teamSchema = z.object({
  Name: text(80).pipe(z.string().min(2, "Enter a team name.")),
  Description: text(500).optional().default("")
});
var messageFile = {
  File_Name: z.string().trim().max(180).optional().default(""),
  Mime_Type: z.string().trim().max(120).optional().default(""),
  Content_Base64: z.string().max(6e6).optional().default("")
};
var workspaceMessageSchema = z.object({
  Body: z.string().trim().max(4e3).default(""),
  ...messageFile
}).refine((value) => value.Body.length > 0 || value.Content_Base64.length > 0, { message: "Write a message or attach a file." });
var directMessageSchema = z.object({
  Recipient_ID: z.string().min(1, "Choose a person."),
  Body: z.string().trim().max(4e3).default(""),
  ...messageFile
}).refine((value) => value.Body.length > 0 || value.Content_Base64.length > 0, { message: "Write a message or attach a file." });
var projectSchema = z.object({
  Team_ID: z.string().min(1, "Choose a team."),
  Name: text(80).pipe(z.string().min(2, "Enter a project name.")),
  Key: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/, "Use 2 to 10 letters or numbers, starting with a letter.")
});
var addMemberSchema = z.object({
  User_ID: z.string().min(1, "Choose a person."),
  Member_Role: z.enum(MEMBER_ROLES)
});
var inviteSchema = z.object({
  Email: z.string().trim().email("Enter a valid email address.").max(180),
  Team_ID: z.string().min(1, "Choose a team."),
  Access_Role: z.enum(ACCESS_ROLES),
  Member_Role: z.enum(MEMBER_ROLES)
});
var respondInviteSchema = z.object({
  accept: z.boolean()
});
var userSchema = z.object({
  Name: text(120).pipe(z.string().min(1, "Name is required.")),
  Email: z.string().trim().email("Enter a valid email address.").max(180),
  Department: text(80).optional().default(""),
  Role: text(120).pipe(z.string().min(1, "Designation is required.")),
  Reports_To: z.array(z.string()).default([]),
  Status: z.enum(["Active", "Inactive"]),
  Access_Role: z.enum(ACCESS_ROLES),
  Scopes: z.array(z.string()).default([])
});
var profileNameSchema = z.object({
  Name: text(80).pipe(z.string().min(2, "Enter the name people should see.")).refine((value) => !/[\[\]@()]/.test(value), "The profile name cannot include @, brackets, or parentheses.")
});
var settingsSchema = z.object({
  workday_start: z.string().regex(/^\d{2}:\d{2}$/),
  workday_end: z.string().regex(/^\d{2}:\d{2}$/),
  workdays: z.array(z.number().int().min(0).max(6)).min(1)
});
var attachmentSchema = z.object({
  File_Name: text(180).pipe(z.string().min(1)),
  Mime_Type: z.string().min(1).max(120),
  Content_Base64: z.string().min(1).max(6e6)
});
function zodMessage(error) {
  return error.issues[0]?.message ?? "Check the form and try again.";
}

// src/domain/permissions.ts
function managerIds(user) {
  return splitIds(user.Reports_To);
}
function descendantIds(users, managerId) {
  const children = /* @__PURE__ */ new Map();
  for (const user of users) {
    for (const managerIdOfUser of managerIds(user)) {
      const list = children.get(managerIdOfUser) ?? [];
      list.push(user.User_ID);
      children.set(managerIdOfUser, list);
    }
  }
  const result = /* @__PURE__ */ new Set();
  const seen = /* @__PURE__ */ new Set();
  const stack = [...children.get(managerId) ?? []];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    result.add(id);
    stack.push(...children.get(id) ?? []);
  }
  return result;
}
function scopedUserIds(actor, users, scopes) {
  if (actor.Access_Role === "Admin") return new Set(users.map((user) => user.User_ID));
  const ids = /* @__PURE__ */ new Set([actor.User_ID]);
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
function canCreateTasks(actor, members = []) {
  if (actor.Status !== "Active") return false;
  if (actor.Access_Role === "Admin") return true;
  return members.some((member) => member.User_ID === actor.User_ID && member.Status === "Active");
}
function canBulkEdit(actor) {
  return actor.Access_Role === "Admin" || actor.Access_Role === "Manager";
}
function canManageUsers(actor) {
  return actor.Access_Role === "Admin";
}
function onTeam(members, userId, teamId) {
  return members.some((member) => member.User_ID === userId && member.Team_ID === teamId && member.Status === "Active");
}
function inWorkspace(actor, members) {
  if (actor.Status !== "Active") return false;
  if (actor.Access_Role === "Admin") return true;
  return members.some((member) => member.User_ID === actor.User_ID && member.Status === "Active");
}
function canAssignTo(actor, assigneeId, _users, _scopes, members = [], teamId = "") {
  if (actor.Status !== "Active" || !teamId) return false;
  if (actor.Access_Role !== "Admin" && !onTeam(members, actor.User_ID, teamId)) return false;
  return onTeam(members, assigneeId, teamId);
}
function effectiveReviewer(task, workflow) {
  return workflow?.Reviewer_ID || task.Assigned_By;
}
function taskCcIds(task) {
  return splitIds(task.CC_User_Ids || "");
}
function canViewTask(actor, task, workflow, users, scopes, members = []) {
  if (!inWorkspace(actor, members)) return false;
  if (actor.Access_Role !== "Admin" && task.Team_ID && !onTeam(members, actor.User_ID, task.Team_ID)) return false;
  if (actor.Access_Role === "Admin") return true;
  if (actor.Access_Role === "Manager" && task.Team_ID && onTeam(members, actor.User_ID, task.Team_ID)) return true;
  if (task.Assigned_To === actor.User_ID || task.Assigned_By === actor.User_ID) return true;
  if (taskCcIds(task).includes(actor.User_ID)) return true;
  if (effectiveReviewer(task, workflow) === actor.User_ID) return true;
  if (actor.Access_Role === "Coordinator") {
    return scopedUserIds(actor, users, scopes).has(task.Assigned_To);
  }
  return false;
}
function canEditTaskMetadata(actor, task, users, scopes, members = []) {
  if (!inWorkspace(actor, members)) return false;
  if (actor.Access_Role !== "Admin" && task.Team_ID && !onTeam(members, actor.User_ID, task.Team_ID)) return false;
  if (actor.Access_Role === "Employee") return false;
  if (actor.Access_Role === "Admin") return true;
  return scopedUserIds(actor, users, scopes).has(task.Assigned_To);
}
function canWorkTask(actor, task, users, scopes, members = []) {
  if (!inWorkspace(actor, members)) return false;
  if (actor.Access_Role !== "Admin" && task.Team_ID && !onTeam(members, actor.User_ID, task.Team_ID)) return false;
  if (actor.Access_Role === "Admin") return true;
  if (task.Assigned_To === actor.User_ID) return true;
  if (actor.Access_Role === "Manager" || actor.Access_Role === "Coordinator") {
    return scopedUserIds(actor, users, scopes).has(task.Assigned_To);
  }
  return false;
}
function canReview(actor, task, _workflow, _users, _scopes, members = []) {
  if (!inWorkspace(actor, members)) return false;
  if (actor.Access_Role !== "Admin" && task.Team_ID && !onTeam(members, actor.User_ID, task.Team_ID)) return false;
  if (actor.Access_Role === "Admin") return true;
  if (task.Assigned_By === actor.User_ID) return true;
  if (actor.Access_Role === "Manager" && taskCcIds(task).includes(actor.User_ID)) return true;
  return false;
}
function meetingAttendeeIds(meeting) {
  return Array.from(/* @__PURE__ */ new Set([meeting.Organized_By, ...splitIds(meeting.Attendees)]));
}
function canViewMeeting(actor, meeting, users, scopes, members = []) {
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
function canViewActivity(actor, log2, tasks, workflows, meetings, users, scopes, members = []) {
  if (!inWorkspace(actor, members) && log2.Entity_ID !== actor.User_ID) return false;
  if (actor.Access_Role === "Admin") return true;
  if (log2.Entity_Type === "user") return log2.Entity_ID === actor.User_ID;
  if (log2.Entity_Type === "team") return onTeam(members, actor.User_ID, log2.Entity_ID);
  if (log2.Actor_ID === actor.User_ID) {
    if (log2.Entity_Type === "task") {
      const task = tasks.find((item) => item.Task_ID === log2.Entity_ID);
      return task ? canViewTask(actor, task, workflows.find((item) => item.Task_ID === task.Task_ID), users, scopes, members) : false;
    }
    if (log2.Entity_Type === "meeting") {
      const meeting = meetings.find((item) => item.Meeting_ID === log2.Entity_ID);
      return meeting ? canViewMeeting(actor, meeting, users, scopes, members) : false;
    }
  }
  if (log2.Entity_Type === "task") {
    const task = tasks.find((item) => item.Task_ID === log2.Entity_ID);
    return task ? canViewTask(actor, task, workflows.find((item) => item.Task_ID === task.Task_ID), users, scopes, members) : false;
  }
  if (log2.Entity_Type === "meeting") {
    const meeting = meetings.find((item) => item.Meeting_ID === log2.Entity_ID);
    return meeting ? canViewMeeting(actor, meeting, users, scopes, members) : false;
  }
  return false;
}
function roleRank(role) {
  return { Admin: 0, Manager: 1, Coordinator: 2, Employee: 3 }[role];
}

// src/domain/workspace.ts
function emptyWorkspace(now = /* @__PURE__ */ new Date()) {
  const stamp = now.toISOString();
  return {
    version: 2,
    users: [],
    teams: [],
    members: [],
    projects: [],
    invites: [],
    tasks: [],
    workflows: [],
    comments: [],
    messages: [],
    attachments: [],
    meetings: [],
    meetingDetails: [],
    activity: [],
    notifications: [],
    settings: [
      { Key: "workday_start", Value: "09:30", Description: "Working day start in Asia/Kolkata" },
      { Key: "workday_end", Value: "18:30", Description: "Working day end in Asia/Kolkata" },
      { Key: "workdays", Value: "1,2,3,4,5", Description: "Monday is 1 and Sunday is 0" },
      { Key: "timezone", Value: "Asia/Kolkata", Description: "Workspace timezone" },
      { Key: "created_at", Value: stamp, Description: "When this workspace was created" }
    ],
    scopes: [],
    busy: []
  };
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function prepareDatabase(input) {
  const raw = input && typeof input === "object" ? input : {};
  const users = asArray(raw.users);
  if (users.length > 0 && users.every((user) => isPlaceholderEmail(user.Email || ""))) {
    return { db: emptyWorkspace(), persist: true };
  }
  const settings = asArray(raw.settings);
  const persist = raw.version !== 2 || !Array.isArray(raw.teams) || !Array.isArray(raw.invites) || !settings.some((item) => item.Key === "workday_start");
  return { db: normalize(raw), persist };
}
function normalize(raw) {
  const empty = emptyWorkspace();
  const settings = asArray(raw.settings);
  for (const setting2 of empty.settings) {
    if (!settings.some((item) => item.Key === setting2.Key)) settings.push(setting2);
  }
  return {
    version: 2,
    users: asArray(raw.users),
    teams: asArray(raw.teams),
    members: asArray(raw.members),
    projects: asArray(raw.projects).map((project) => ({ ...project, Next_Number: Number(project.Next_Number || 1) })),
    invites: asArray(raw.invites),
    tasks: asArray(raw.tasks).map((task) => ({
      ...task,
      Type: task.Type || "Task",
      Team_ID: task.Team_ID || "",
      Project_ID: task.Project_ID || "",
      Key: task.Key || task.Task_ID,
      Severity: task.Severity || "",
      Labels: task.Labels || "",
      CC_User_Ids: task.CC_User_Ids || ""
    })),
    workflows: asArray(raw.workflows),
    comments: asArray(raw.comments),
    messages: asArray(raw.messages).map((message) => ({
      ...message,
      Recipient_ID: message.Recipient_ID || "",
      File_Name: message.File_Name || "",
      Mime_Type: message.Mime_Type || "",
      Size_Bytes: Number(message.Size_Bytes) || 0,
      Storage_Ref: message.Storage_Ref || ""
    })),
    attachments: asArray(raw.attachments),
    meetings: asArray(raw.meetings),
    meetingDetails: asArray(raw.meetingDetails),
    activity: asArray(raw.activity),
    notifications: asArray(raw.notifications),
    settings,
    scopes: asArray(raw.scopes),
    busy: asArray(raw.busy)
  };
}
function activeMemberships(members, userId) {
  return members.filter((member) => member.User_ID === userId && member.Status === "Active");
}
function hasWorkspaceAccess(db, user) {
  if (user.Status !== "Active") return false;
  if (user.Access_Role === "Admin") return true;
  return activeMemberships(db.members, user.User_ID).length > 0;
}
function onTeam2(members, userId, teamId) {
  return members.some((member) => member.User_ID === userId && member.Team_ID === teamId && member.Status === "Active");
}
function canInviteToTeam(actor, teamId, members) {
  if (actor.Status !== "Active" || actor.Access_Role === "Employee") return false;
  if (actor.Access_Role === "Admin") return true;
  const membership = members.find((member) => member.User_ID === actor.User_ID && member.Team_ID === teamId && member.Status === "Active");
  if (!membership) return false;
  if (membership.Member_Role === "Lead") return true;
  return actor.Access_Role === "Manager";
}
function higherRole(current, offered) {
  return roleRank(offered) < roleRank(current) ? offered : current;
}

// src/domain/workflow.ts
var NEXT = {
  "To Do": ["In Progress", "Blocked"],
  "In Progress": ["Under Review", "Blocked", "To Do"],
  Blocked: ["In Progress", "To Do"],
  "Under Review": ["Completed", "In Progress"],
  Completed: ["In Progress"]
};
function transitionAllowed(input) {
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

// src/domain/format.ts
function commentParts(body, users) {
  const parts = [];
  const pattern = /@\[([^\]]+)\]\(([^)\s]+)\)/g;
  let cursor = 0;
  for (const match of body.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ kind: "text", value: body.slice(cursor, index) });
    const user = users.find((item) => item.User_ID === match[2]);
    parts.push({ kind: "mention", userId: match[2], label: user?.Name || match[1] });
    cursor = index + match[0].length;
  }
  if (cursor < body.length) parts.push({ kind: "text", value: body.slice(cursor) });
  return parts;
}
function mentionIds(body) {
  return Array.from(new Set(commentParts(body, []).flatMap((part) => part.kind === "mention" ? [part.userId] : [])));
}

// server/errors.ts
var HttpError = class extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};

// server/actions.ts
function normalizeCc(db, teamId, assigneeId, ids) {
  const unique = Array.from(new Set((ids ?? []).map((id) => id.trim()).filter(Boolean)));
  for (const id of unique) {
    if (id === assigneeId) continue;
    if (!onTeam2(db.members, id, teamId)) throw new HttpError(400, "CC people must be active members of this group.");
    const person = db.users.find((user) => user.User_ID === id);
    if (!person || person.Status !== "Active") throw new HttpError(400, "CC people must be active members of this group.");
  }
  return joinIds(unique.filter((id) => id !== assigneeId));
}
function notifyCc(db, task, actorId, type, title, body) {
  for (const id of taskCcIds(task)) {
    notify(db, id, actorId, type, title, body, "task", task.Task_ID);
  }
}
function notifyReviewAudience(db, task, workflow, actorId) {
  const targets = /* @__PURE__ */ new Set([task.Assigned_By, effectiveReviewer(task, workflow)]);
  for (const id of taskCcIds(task)) {
    const person = db.users.find((user) => user.User_ID === id);
    if (person && (person.Access_Role === "Manager" || person.Access_Role === "Admin")) targets.add(id);
  }
  for (const id of targets) {
    notify(db, id, actorId, "submitted_for_review", "Task submitted for review", task.Task_Title, "task", task.Task_ID);
  }
}
var pushDispatch = null;
function setPushDispatch(fn) {
  pushDispatch = fn;
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function userById(db, id) {
  const user = db.users.find((item) => item.User_ID === id);
  if (!user) throw new HttpError(404, "Employee not found.");
  return user;
}
function taskById(db, id) {
  const task = db.tasks.find((item) => item.Task_ID === id);
  if (!task) throw new HttpError(404, "Task not found.");
  return task;
}
function meetingById(db, id) {
  const meeting = db.meetings.find((item) => item.Meeting_ID === id);
  if (!meeting) throw new HttpError(404, "Meeting not found.");
  return meeting;
}
function workflowOf(db, taskId) {
  return db.workflows.find((item) => item.Task_ID === taskId);
}
function ensureWorkflow(db, task) {
  let workflow = workflowOf(db, task.Task_ID);
  if (!workflow) {
    workflow = { Task_ID: task.Task_ID, Reviewer_ID: task.Assigned_By, Blocked_Reason: "", Review_Note: "" };
    db.workflows.push(workflow);
  }
  return workflow;
}
function nameOf(db, id) {
  return db.users.find((user) => user.User_ID === id)?.Name ?? id;
}
function log(db, actorId, action, entityType, entityId, oldValue, newValue) {
  db.activity.unshift({
    Log_ID: nextId("L-", db.activity.map((item) => item.Log_ID), 5),
    Timestamp: nowIso(),
    Actor_ID: actorId,
    Action: action,
    Entity_Type: entityType,
    Entity_ID: entityId,
    Old_Value: oldValue,
    New_Value: newValue
  });
}
function notify(db, recipientId, actorId, type, title, body, entityType, entityId) {
  if (!recipientId || recipientId === actorId) return;
  pushDispatch?.(recipientId, title, body, entityType, entityId);
  db.notifications.unshift({
    Notification_ID: nextId("N-", db.notifications.map((item) => item.Notification_ID), 4),
    Recipient_ID: recipientId,
    Type: type,
    Title: title,
    Body: body,
    Entity_Type: entityType,
    Entity_ID: entityId,
    Read_At: "",
    Created_At: nowIso()
  });
}
function assertFresh(current, expected) {
  if (current !== expected) {
    throw new HttpError(409, "This was updated by someone else. Refresh and try again.");
  }
}
function setting(db, key, fallback) {
  return db.settings.find((item) => item.Key === key)?.Value || fallback;
}
function workdays(db) {
  return setting(db, "workdays", "1,2,3,4,5").split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value));
}
function canManageMeeting(actor, meeting, db) {
  if (actor.Access_Role === "Admin") return true;
  if (meeting.Organized_By === actor.User_ID) return true;
  if (actor.Access_Role === "Manager" || actor.Access_Role === "Coordinator") {
    return scopedUserIds(actor, db.users, db.scopes).has(meeting.Organized_By);
  }
  return false;
}
function visibleData(db, actor) {
  const tasks = hasWorkspaceAccess(db, actor) ? db.tasks.filter((task) => canViewTask(actor, task, workflowOf(db, task.Task_ID), db.users, db.scopes, db.members)) : [];
  const taskIds = new Set(tasks.map((task) => task.Task_ID));
  const meetings = hasWorkspaceAccess(db, actor) ? db.meetings.filter((meeting) => canViewMeeting(actor, meeting, db.users, db.scopes, db.members)) : [];
  const meetingIds = new Set(meetings.map((meeting) => meeting.Meeting_ID));
  const teamIds = actor.Access_Role === "Admin" ? new Set(db.teams.map((team) => team.Team_ID)) : new Set(db.members.filter((member) => member.User_ID === actor.User_ID && member.Status === "Active").map((member) => member.Team_ID));
  const users = !hasWorkspaceAccess(db, actor) ? db.users.filter((user) => user.User_ID === actor.User_ID) : actor.Access_Role === "Admin" ? db.users : db.users.filter((user) => user.Status === "Active" || user.User_ID === actor.User_ID);
  const invites = db.invites.filter((invite) => {
    if (invite.Email.toLowerCase() === actor.Email.toLowerCase()) return true;
    return hasWorkspaceAccess(db, actor) && (actor.Access_Role === "Admin" || teamIds.has(invite.Team_ID));
  });
  return {
    access: hasWorkspaceAccess(db, actor) ? "workspace" : "waiting",
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
    activity: db.activity.filter((item) => canViewActivity(actor, item, db.tasks, db.workflows, db.meetings, db.users, db.scopes, db.members)).slice(0, 500),
    notifications: db.notifications.filter((item) => item.Recipient_ID === actor.User_ID).slice(0, 100),
    settings: db.settings,
    scopes: db.scopes,
    messages: (db.messages ?? []).filter((message) => {
      if (message.Recipient_ID) return message.Author_ID === actor.User_ID || message.Recipient_ID === actor.User_ID;
      return teamIds.has(message.Team_ID);
    }).slice(-400)
  };
}
function ensureDerivedNotifications(db, userId, now = /* @__PURE__ */ new Date()) {
  const today = kolkataToday(now);
  const tomorrow = addDays(today, 1);
  for (const task of db.tasks) {
    if (task.Assigned_To !== userId || task.Status === "Completed") continue;
    const overdue = isOverdue(task, today);
    const approaching = !overdue && (task.Due_Date === today || task.Due_Date === tomorrow);
    if (!overdue && !approaching) continue;
    const type = overdue ? "task_overdue" : "deadline_approaching";
    const exists = db.notifications.some(
      (item) => item.Recipient_ID === userId && item.Type === type && item.Entity_ID === task.Task_ID
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
      task.Task_ID
    );
  }
}
function requireVisibleTask(db, actor, taskId) {
  const task = taskById(db, taskId);
  if (!canViewTask(actor, task, workflowOf(db, task.Task_ID), db.users, db.scopes, db.members)) {
    throw new HttpError(403, "You cannot view this task.");
  }
  return task;
}
function createTask(db, actor, input) {
  if (!hasWorkspaceAccess(db, actor)) throw new HttpError(403, "Accept an invite before opening the workspace.");
  if (!canCreateTasks(actor, db.members)) throw new HttpError(403, "You cannot create work.");
  const team = db.teams.find((item) => item.Team_ID === input.Team_ID && item.Status === "Active");
  if (!team) throw new HttpError(400, "Choose an active team.");
  if (actor.Access_Role !== "Admin" && !onTeam2(db.members, actor.User_ID, team.Team_ID)) {
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
  const cc = normalizeCc(db, team.Team_ID, assignee.User_ID, input.CC_User_Ids);
  const reviewer = actor;
  const stamp = nowIso();
  const number = project.Next_Number || 1;
  project.Next_Number = number + 1;
  const task = {
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
    CC_User_Ids: cc
  };
  db.tasks.unshift(task);
  db.workflows.push({ Task_ID: task.Task_ID, Reviewer_ID: reviewer.User_ID, Blocked_Reason: "", Review_Note: "" });
  log(db, actor.User_ID, "task.created", "task", task.Task_ID, "", task.Task_Title);
  log(db, actor.User_ID, "task.assigned", "task", task.Task_ID, "", assignee.Name);
  notify(db, assignee.User_ID, actor.User_ID, "task_assigned", "New task assigned", task.Task_Title, "task", task.Task_ID);
  notifyCc(db, task, actor.User_ID, "task_assigned", "Added on CC", task.Task_Title);
  return task;
}
function updateTask(db, actor, taskId, patch) {
  const task = requireVisibleTask(db, actor, taskId);
  assertFresh(task.Updated_At, patch.Updated_At);
  const assigning = Boolean(patch.Assigned_To && patch.Assigned_To !== task.Assigned_To);
  const changingCc = patch.CC_User_Ids !== void 0;
  const changingDetails = Boolean(
    patch.Task_Title && patch.Task_Title !== task.Task_Title || patch.Description !== void 0 && patch.Description !== task.Description || patch.Priority && patch.Priority !== task.Priority || patch.Start_Date !== void 0 && patch.Start_Date !== task.Start_Date || patch.Due_Date && patch.Due_Date !== task.Due_Date || patch.Labels !== void 0 && patch.Labels !== task.Labels || patch.Severity !== void 0 && patch.Severity !== task.Severity || patch.Department && patch.Department !== task.Department || patch.Remarks !== void 0 && patch.Remarks !== task.Remarks
  );
  const canMeta = canEditTaskMetadata(actor, task, db.users, db.scopes, db.members);
  const canCc = canMeta || task.Assigned_By === actor.User_ID || actor.Access_Role === "Admin";
  if (changingDetails && !canMeta) {
    throw new HttpError(403, "You cannot change the deadline, priority, or details of this task.");
  }
  if (changingCc && !canCc) {
    throw new HttpError(403, "You cannot change who is on CC for this task.");
  }
  if (!assigning && !changingDetails && !changingCc && !canMeta) {
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
    ensureWorkflow(db, task).Reviewer_ID = actor.User_ID;
    if (!patch.Department) task.Department = assignee.Department;
    if (task.CC_User_Ids) task.CC_User_Ids = normalizeCc(db, task.Team_ID, assignee.User_ID, splitIds(task.CC_User_Ids));
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
  if (patch.Description !== void 0 && patch.Description !== task.Description) {
    task.Description = patch.Description;
    genericChange = true;
  }
  if (patch.Start_Date !== void 0 && patch.Start_Date !== task.Start_Date) {
    task.Start_Date = patch.Start_Date;
    genericChange = true;
  }
  if (patch.Labels !== void 0 && patch.Labels !== task.Labels) {
    task.Labels = patch.Labels;
    genericChange = true;
  }
  if (patch.Severity !== void 0 && patch.Severity !== task.Severity) {
    if (task.Type === "Bug" && !patch.Severity) throw new HttpError(400, "A bug needs a severity.");
    task.Severity = task.Type === "Bug" ? patch.Severity : "";
    genericChange = true;
  }
  if (patch.Department && patch.Department !== task.Department) {
    task.Department = patch.Department;
    genericChange = true;
  }
  if (patch.Remarks !== void 0 && patch.Remarks !== task.Remarks) {
    task.Remarks = patch.Remarks;
    genericChange = true;
  }
  if (patch.CC_User_Ids !== void 0) {
    const next = normalizeCc(db, task.Team_ID, task.Assigned_To, patch.CC_User_Ids);
    if (next !== task.CC_User_Ids) {
      const previous = task.CC_User_Ids;
      task.CC_User_Ids = next;
      log(db, actor.User_ID, "task.cc", "task", task.Task_ID, previous, next);
      for (const id of splitIds(next)) {
        if (!splitIds(previous).includes(id)) {
          notify(db, id, actor.User_ID, "task_assigned", "Added on CC", task.Task_Title, "task", task.Task_ID);
        }
      }
    }
  }
  task.Updated_At = nowIso();
  if (genericChange) log(db, actor.User_ID, "task.updated", "task", task.Task_ID, "", task.Task_Title);
  return task;
}
function rejectTransition(message) {
  const denied = /cannot|only an administrator/i.test(message);
  throw new HttpError(denied ? 403 : 400, message);
}
function transitionTask(db, actor, taskId, to, reason, expectedUpdatedAt) {
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
    notifyReviewAudience(db, task, workflow, actor.User_ID);
  }
  if (from === "Under Review" && to === "In Progress") {
    workflow.Review_Note = reason.trim();
    db.comments.unshift({
      Comment_ID: nextId("C-", db.comments.map((item) => item.Comment_ID), 4),
      Task_ID: task.Task_ID,
      Author_ID: actor.User_ID,
      Body: `Returned: ${reason.trim()}`,
      Created_At: task.Updated_At
    });
    notify(db, task.Assigned_To, actor.User_ID, "task_returned", "Task returned", task.Task_Title, "task", task.Task_ID);
  }
  return task;
}
function addComment(db, actor, taskId, body) {
  const task = requireVisibleTask(db, actor, taskId);
  const comment = {
    Comment_ID: nextId("C-", db.comments.map((item) => item.Comment_ID), 4),
    Task_ID: task.Task_ID,
    Author_ID: actor.User_ID,
    Body: body,
    Created_At: nowIso()
  };
  db.comments.unshift(comment);
  task.Updated_At = comment.Created_At;
  for (const id of mentionIds(body)) {
    if (!db.users.some((user) => user.User_ID === id && user.Status === "Active")) continue;
    notify(db, id, actor.User_ID, "mentioned", `${actor.Name} mentioned you`, task.Task_Title, "task", task.Task_ID);
  }
  return comment;
}
function addAttachment(db, actor, taskId, file) {
  const task = requireVisibleTask(db, actor, taskId);
  const id = file.id || nextId("A-", db.attachments.map((item) => item.Attachment_ID), 4);
  const attachment = {
    Attachment_ID: id,
    Task_ID: task.Task_ID,
    File_Name: file.name,
    Mime_Type: file.mime,
    Size_Bytes: file.size,
    Uploaded_By: actor.User_ID,
    Uploaded_At: nowIso(),
    Storage_Ref: file.storage || id
  };
  db.attachments.unshift(attachment);
  task.Updated_At = attachment.Uploaded_At;
  return attachment;
}
function bulkUpdate(db, actor, ids, change) {
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
        reason: change.reason
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
function invitationStatus(db, attendeeIds, responses) {
  const status = {};
  for (const id of attendeeIds) {
    const email = db.users.find((user) => user.User_ID === id)?.Email.toLowerCase();
    status[id] = email && responses?.[email] || "invited";
  }
  return status;
}
function applyGoogle(db, meeting, google) {
  if (!google) return;
  meeting.Calendar_Event_ID = google.eventId;
  meeting.Google_Meet_Link = google.meetLink;
  const detail = db.meetingDetails.find((item) => item.Meeting_ID === meeting.Meeting_ID);
  if (detail) {
    detail.Calendar_Link = google.htmlLink;
    detail.Invitation_Status = invitationStatus(db, meetingAttendeeIds(meeting), google.responses);
  }
}
function createMeeting(db, actor, input, google) {
  const attendeeIds = Array.from(/* @__PURE__ */ new Set([actor.User_ID, ...input.Attendees]));
  for (const id of attendeeIds) {
    const person = userById(db, id);
    if (person.Status !== "Active") throw new HttpError(400, `${person.Name} is inactive and cannot be invited.`);
  }
  const stamp = nowIso();
  const meeting = {
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
    Updated_At: stamp
  };
  db.meetings.unshift(meeting);
  db.meetingDetails.push({
    Meeting_ID: meeting.Meeting_ID,
    Reminder_Minutes: input.Reminder_Minutes,
    Calendar_Link: "",
    Invitation_Status: invitationStatus(db, attendeeIds, google?.responses)
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
function updateMeeting(db, actor, meetingId, input, google) {
  const meeting = meetingById(db, meetingId);
  if (!canViewMeeting(actor, meeting, db.users, db.scopes, db.members)) throw new HttpError(403, "You cannot view this meeting.");
  if (!canManageMeeting(actor, meeting, db)) throw new HttpError(403, "You cannot change this meeting.");
  if (meeting.Status === "Cancelled") throw new HttpError(400, "Cancelled meetings cannot be edited.");
  assertFresh(meeting.Updated_At, input.Updated_At);
  const attendeeIds = Array.from(/* @__PURE__ */ new Set([meeting.Organized_By, ...input.Attendees]));
  for (const id of attendeeIds) {
    const person = userById(db, id);
    if (person.Status !== "Active" && !meetingAttendeeIds(meeting).includes(id)) {
      throw new HttpError(400, `${person.Name} is inactive and cannot be invited.`);
    }
  }
  const nextStart = kolkataToIso(input.Date, input.Start_Time);
  const nextEnd = kolkataToIso(input.Date, input.End_Time);
  const moved = nextStart !== meeting.Start_DateTime || nextEnd !== meeting.End_DateTime;
  const previous = `${meeting.Start_DateTime} \u2192 ${meeting.End_DateTime}`;
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
    log(db, actor.User_ID, "meeting.rescheduled", "meeting", meeting.Meeting_ID, previous, `${nextStart} \u2192 ${nextEnd}`);
    for (const id of attendeeIds) {
      notify(db, id, actor.User_ID, "meeting_rescheduled", meeting.Meeting_Title, "The meeting time has changed.", "meeting", meeting.Meeting_ID);
    }
  }
  return meeting;
}
function cancelMeeting(db, actor, meetingId, expectedUpdatedAt) {
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
function respondMeeting(db, actor, meetingId, response) {
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
function syncMeeting(db, actor, meetingId, google) {
  const meeting = meetingById(db, meetingId);
  if (!canViewMeeting(actor, meeting, db.users, db.scopes, db.members)) throw new HttpError(403, "You cannot view this meeting.");
  if (google.status === "cancelled") {
    meeting.Status = "Cancelled";
  }
  if (google.start && google.end && (google.start !== meeting.Start_DateTime || google.end !== meeting.End_DateTime)) {
    const previous = `${meeting.Start_DateTime} \u2192 ${meeting.End_DateTime}`;
    meeting.Start_DateTime = new Date(google.start).toISOString();
    meeting.End_DateTime = new Date(google.end).toISOString();
    log(db, actor.User_ID, "meeting.rescheduled", "meeting", meeting.Meeting_ID, previous, `${meeting.Start_DateTime} \u2192 ${meeting.End_DateTime}`);
  }
  if (google.location) meeting.Location = google.location;
  meeting.Updated_At = nowIso();
  applyGoogle(db, meeting, google);
  return meeting;
}
function knownBusy(db, userId) {
  const windows = [];
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
function availabilityFor(db, attendeeIds, rangeStart, rangeEnd, externalByEmail) {
  return attendeeIds.map((id) => {
    const person = userById(db, id);
    const internal = knownBusy(db, id).filter((item) => overlaps(item.start, item.end, rangeStart, rangeEnd));
    const external = externalByEmail[person.Email.toLowerCase()] ?? { state: "unknown" };
    return { ...mergeAvailability({ userId: id, rangeStart, rangeEnd, internal, external }), name: person.Name };
  });
}
function slotsFor(db, attendeeIds, day2, durationMinutes, externalBusy, confirmed) {
  for (const id of attendeeIds) userById(db, id);
  const busy = [...externalBusy];
  for (const id of attendeeIds) busy.push(...knownBusy(db, id));
  return findSlots({
    day: day2,
    durationMinutes,
    workStart: setting(db, "workday_start", "09:30"),
    workEnd: setting(db, "workday_end", "18:30"),
    workdays: workdays(db),
    busy,
    confirmed
  });
}
function assertNoCycle(db, userId, managers) {
  if (managers.includes(userId)) throw new HttpError(400, "An employee cannot report to themselves.");
  const descendants = descendantIds(db.users, userId);
  if (managers.some((id) => descendants.has(id))) {
    throw new HttpError(400, "That reporting line would create a cycle.");
  }
  for (const id of managers) userById(db, id);
}
function replaceScopes(db, userId, role, departments) {
  db.scopes = db.scopes.filter((scope) => scope.User_ID !== userId);
  if (role !== "Coordinator") return;
  for (const department of Array.from(new Set(departments.map((item) => item.trim()).filter(Boolean)))) {
    db.scopes.push({ User_ID: userId, Scope_Type: "department", Scope_Value: department });
  }
}
function assertAdminRemains(db, userId, next) {
  const remaining = db.users.filter((user) => {
    if (user.User_ID === userId) return next.Status === "Active" && next.Access_Role === "Admin";
    return user.Status === "Active" && user.Access_Role === "Admin";
  }).length;
  if (remaining < 1) throw new HttpError(400, "The organisation needs at least one active administrator.");
}
function saveUser(db, actor, input) {
  if (!canManageUsers(actor)) throw new HttpError(403, "Only an administrator can change employee access.");
  const email = input.Email.toLowerCase();
  const duplicate = db.users.find((user2) => user2.Email.toLowerCase() === email && user2.User_ID !== input.User_ID);
  if (duplicate) throw new HttpError(400, "Another employee already uses that email.");
  if (input.User_ID) {
    const user2 = userById(db, input.User_ID);
    if (user2.User_ID === actor.User_ID && input.Status === "Inactive") {
      throw new HttpError(400, "You cannot deactivate your own account.");
    }
    assertAdminRemains(db, user2.User_ID, input);
    assertNoCycle(db, user2.User_ID, input.Reports_To);
    const previousRole = user2.Access_Role;
    const previousStatus = user2.Status;
    user2.Name = input.Name;
    user2.Email = email;
    user2.Department = input.Department;
    user2.Role = input.Role;
    user2.Reports_To = joinIds(input.Reports_To);
    user2.Status = input.Status;
    if (input.Status === "Inactive") {
      for (const membership of db.members) {
        if (membership.User_ID === user2.User_ID) membership.Status = "Inactive";
      }
    }
    user2.Access_Role = input.Access_Role;
    replaceScopes(db, user2.User_ID, input.Access_Role, input.Scopes);
    if (previousRole !== input.Access_Role || previousStatus !== input.Status) {
      log(db, actor.User_ID, "user.access", "user", user2.User_ID, previousRole, input.Access_Role);
    } else {
      log(db, actor.User_ID, "user.updated", "user", user2.User_ID, "", user2.Name);
    }
    return user2;
  }
  const user = {
    User_ID: nextId("U-", db.users.map((item) => item.User_ID), 3),
    Name: input.Name,
    Email: email,
    Department: input.Department,
    Role: input.Role,
    Reports_To: joinIds(input.Reports_To),
    Status: input.Status,
    Access_Role: input.Access_Role
  };
  db.users.push(user);
  assertNoCycle(db, user.User_ID, input.Reports_To);
  assertAdminRemains(db, user.User_ID, user);
  replaceScopes(db, user.User_ID, user.Access_Role, input.Scopes);
  log(db, actor.User_ID, "user.updated", "user", user.User_ID, "", user.Name);
  return user;
}
function renameSelf(db, actor, name) {
  const cleaned = name.trim().replace(/\s+/g, " ");
  if (cleaned.length < 2 || cleaned.length > 80) throw new HttpError(400, "Enter the name people should see.");
  if (/[\[\]@()]/.test(cleaned)) throw new HttpError(400, "The profile name cannot include @, brackets, or parentheses.");
  const taken = db.users.find((user2) => user2.User_ID !== actor.User_ID && user2.Status === "Active" && user2.Name.toLowerCase() === cleaned.toLowerCase());
  if (taken) throw new HttpError(400, "That profile name is already used. Choose one people can tag uniquely.");
  const user = userById(db, actor.User_ID);
  if (user.Status !== "Active") throw new HttpError(403, "This account is inactive.");
  if (user.Name === cleaned) return user;
  const previous = user.Name;
  user.Name = cleaned;
  log(db, actor.User_ID, "user.renamed", "user", user.User_ID, previous, cleaned);
  return user;
}
function updateSettings(db, actor, input) {
  if (!canManageUsers(actor)) throw new HttpError(403, "Only an administrator can change working hours.");
  if (input.workday_end <= input.workday_start) throw new HttpError(400, "The working day must end after it starts.");
  const write = (key, value) => {
    const row = db.settings.find((item) => item.Key === key);
    if (row) row.Value = value;
    else db.settings.push({ Key: key, Value: value, Description: key });
  };
  write("workday_start", input.workday_start);
  write("workday_end", input.workday_end);
  write("workdays", input.workdays.join(","));
}
var emptyFile = { File_Name: "", Mime_Type: "", Size_Bytes: 0, Storage_Ref: "" };
function postWorkspaceMessage(db, actor, teamId, body, file = emptyFile) {
  if (!hasWorkspaceAccess(db, actor)) throw new HttpError(403, "Accept an invite before opening the workspace.");
  const team = db.teams.find((item) => item.Team_ID === teamId && item.Status === "Active");
  if (!team) throw new HttpError(404, "That workspace was not found.");
  if (actor.Access_Role !== "Admin" && !onTeam2(db.members, actor.User_ID, team.Team_ID)) {
    throw new HttpError(403, "Join this workspace before sending a message.");
  }
  const text2 = body.trim();
  if (!text2 && !file.Storage_Ref) throw new HttpError(400, "Write a message or attach a file.");
  const message = {
    Message_ID: nextId("MSG-", (db.messages ?? []).map((item) => item.Message_ID), 4),
    Team_ID: team.Team_ID,
    Recipient_ID: "",
    Author_ID: actor.User_ID,
    Body: text2.slice(0, 4e3),
    File_Name: file.File_Name.slice(0, 180),
    Mime_Type: file.Mime_Type.slice(0, 120),
    Size_Bytes: file.Size_Bytes,
    Storage_Ref: file.Storage_Ref,
    Created_At: nowIso()
  };
  db.messages = db.messages ?? [];
  db.messages.push(message);
  const preview = text2.replace(/@\[([^\]]+)\]\([^)]+\)/g, "@$1");
  for (const id of mentionIds(text2)) {
    if (!onTeam2(db.members, id, team.Team_ID)) continue;
    if (!db.users.some((user) => user.User_ID === id && user.Status === "Active")) continue;
    notify(db, id, actor.User_ID, "mentioned", `${actor.Name} mentioned you in ${team.Name}`, preview.slice(0, 140), "team", team.Team_ID);
  }
  return message;
}
function postDirectMessage(db, actor, recipientId, body, file = emptyFile) {
  if (!hasWorkspaceAccess(db, actor)) throw new HttpError(403, "Accept an invite before sending a message.");
  if (recipientId === actor.User_ID) throw new HttpError(400, "Choose another person.");
  const recipient = db.users.find((user) => user.User_ID === recipientId && user.Status === "Active");
  if (!recipient) throw new HttpError(404, "That person is not in the directory.");
  const text2 = body.trim();
  if (!text2 && !file.Storage_Ref) throw new HttpError(400, "Write a message or attach a file.");
  const message = {
    Message_ID: nextId("MSG-", (db.messages ?? []).map((item) => item.Message_ID), 4),
    Team_ID: "",
    Recipient_ID: recipient.User_ID,
    Author_ID: actor.User_ID,
    Body: text2.slice(0, 4e3),
    File_Name: file.File_Name.slice(0, 180),
    Mime_Type: file.Mime_Type.slice(0, 120),
    Size_Bytes: file.Size_Bytes,
    Storage_Ref: file.Storage_Ref,
    Created_At: nowIso()
  };
  db.messages = db.messages ?? [];
  db.messages.push(message);
  notify(db, recipient.User_ID, actor.User_ID, "direct_message", `Message from ${actor.Name}`, (text2 || file.File_Name).slice(0, 140), "user", actor.User_ID);
  return message;
}
function createTeam(db, actor, input) {
  if (!hasWorkspaceAccess(db, actor)) throw new HttpError(403, "Accept an invite before creating a group.");
  const name = input.Name.trim();
  if (db.teams.some((team2) => team2.Status === "Active" && team2.Name.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(400, "A group already uses that name.");
  }
  const team = { Team_ID: nextId("TM-", db.teams.map((item) => item.Team_ID), 3), Name: name, Description: input.Description, Status: "Active", Created_At: nowIso() };
  db.teams.unshift(team);
  db.members.push({ Team_ID: team.Team_ID, User_ID: actor.User_ID, Member_Role: "Lead", Status: "Active", Joined_At: nowIso() });
  log(db, actor.User_ID, "team.created", "team", team.Team_ID, "", team.Name);
  return team;
}
function renameTeam(db, actor, teamId, nameInput) {
  if (actor.Access_Role !== "Admin") throw new HttpError(403, "Only an administrator can rename a group.");
  const team = db.teams.find((item) => item.Team_ID === teamId && item.Status === "Active");
  if (!team) throw new HttpError(404, "That group was not found.");
  const name = nameInput.trim();
  if (name.length < 2) throw new HttpError(400, "Enter a team name.");
  if (db.teams.some((item) => item.Team_ID !== teamId && item.Status === "Active" && item.Name.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(400, "A group already uses that name.");
  }
  const previous = team.Name;
  team.Name = name;
  log(db, actor.User_ID, "team.renamed", "team", team.Team_ID, previous, name);
  return team;
}
function deleteTeam(db, actor, teamId) {
  if (actor.Access_Role !== "Admin") throw new HttpError(403, "Only an administrator can delete a group.");
  const team = db.teams.find((item) => item.Team_ID === teamId);
  if (!team) throw new HttpError(404, "That group was not found.");
  const taskIds = new Set(db.tasks.filter((task) => task.Team_ID === teamId).map((task) => task.Task_ID));
  const storageRefs = [];
  for (const file of db.attachments) {
    if (taskIds.has(file.Task_ID) && file.Storage_Ref) storageRefs.push(file.Storage_Ref);
  }
  for (const message of db.messages ?? []) {
    if (message.Team_ID === teamId && message.Storage_Ref) storageRefs.push(message.Storage_Ref);
  }
  db.attachments = db.attachments.filter((item) => !taskIds.has(item.Task_ID));
  db.comments = db.comments.filter((item) => !taskIds.has(item.Task_ID));
  db.workflows = db.workflows.filter((item) => !taskIds.has(item.Task_ID));
  db.tasks = db.tasks.filter((item) => item.Team_ID !== teamId);
  db.messages = (db.messages ?? []).filter((item) => item.Team_ID !== teamId);
  db.invites = db.invites.filter((item) => item.Team_ID !== teamId);
  db.members = db.members.filter((item) => item.Team_ID !== teamId);
  db.projects = db.projects.filter((item) => item.Team_ID !== teamId);
  db.teams = db.teams.filter((item) => item.Team_ID !== teamId);
  log(db, actor.User_ID, "team.deleted", "team", teamId, team.Name, "");
  return { teamId, storageRefs };
}
function createProject(db, actor, input) {
  if (!hasWorkspaceAccess(db, actor)) throw new HttpError(403, "Accept an invite before opening the workspace.");
  const team = db.teams.find((item) => item.Team_ID === input.Team_ID && item.Status === "Active");
  if (!team) throw new HttpError(400, "Choose an active team.");
  const lead = db.members.some((member) => member.Team_ID === team.Team_ID && member.User_ID === actor.User_ID && member.Status === "Active" && member.Member_Role === "Lead");
  if (actor.Access_Role !== "Admin" && !lead) throw new HttpError(403, "Only an administrator or a team lead can add a project.");
  const key = input.Key.toUpperCase();
  if (db.projects.some((project2) => project2.Key.toLowerCase() === key.toLowerCase())) throw new HttpError(400, "That project key is already used.");
  const project = { Project_ID: nextId("P-", db.projects.map((item) => item.Project_ID), 3), Team_ID: team.Team_ID, Name: input.Name.trim(), Key: key, Next_Number: 1, Status: "Active" };
  db.projects.unshift(project);
  log(db, actor.User_ID, "project.created", "team", team.Team_ID, "", `${project.Key} ${project.Name}`);
  return project;
}
function createInvite(db, actor, input) {
  if (!hasWorkspaceAccess(db, actor)) throw new HttpError(403, "Accept an invite before opening the workspace.");
  const team = db.teams.find((item) => item.Team_ID === input.Team_ID && item.Status === "Active");
  if (!team) throw new HttpError(400, "Choose an active team.");
  if (!canInviteToTeam(actor, team.Team_ID, db.members)) throw new HttpError(403, "You cannot invite people to that team.");
  if (input.Access_Role === "Admin" && actor.Access_Role !== "Admin") throw new HttpError(403, "Only an administrator can invite an administrator.");
  const email = input.Email.toLowerCase();
  if (isPlaceholderEmail(email)) throw new HttpError(400, "Invite a real email address.");
  const existingUser = db.users.find((user) => user.Email.toLowerCase() === email);
  if (existingUser && onTeam2(db.members, existingUser.User_ID, team.Team_ID)) throw new HttpError(400, "That person is already in this group.");
  if (db.invites.some((invite2) => invite2.Email.toLowerCase() === email && invite2.Team_ID === team.Team_ID && invite2.Status === "Pending")) {
    throw new HttpError(400, "That person already has a pending invite to this team.");
  }
  const invite = {
    Invite_ID: nextId("I-", db.invites.map((item) => item.Invite_ID), 4),
    Email: email,
    Team_ID: team.Team_ID,
    Access_Role: input.Access_Role,
    Member_Role: input.Member_Role,
    Invited_By: actor.User_ID,
    Status: "Pending",
    Created_At: nowIso(),
    Responded_At: ""
  };
  db.invites.unshift(invite);
  log(db, actor.User_ID, "invite.sent", "team", team.Team_ID, "", email);
  if (existingUser) notify(db, existingUser.User_ID, actor.User_ID, "invited", `Invitation to ${team.Name}`, `${actor.Name} invited you to ${team.Name}. Accept it to join.`, "team", team.Team_ID);
  return invite;
}
function addTeamMember(db, actor, teamId, userId, memberRole) {
  if (!hasWorkspaceAccess(db, actor)) throw new HttpError(403, "Accept an invite before opening the workspace.");
  const team = db.teams.find((item) => item.Team_ID === teamId && item.Status === "Active");
  if (!team) throw new HttpError(404, "That group was not found.");
  if (!canInviteToTeam(actor, team.Team_ID, db.members)) throw new HttpError(403, "You cannot add people to that group.");
  const person = db.users.find((user) => user.User_ID === userId && user.Status === "Active");
  if (!person) throw new HttpError(404, "That person is not in the directory.");
  if (onTeam2(db.members, person.User_ID, team.Team_ID)) throw new HttpError(400, "That person is already in this group.");
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
function revokeInvite(db, actor, inviteId) {
  const invite = db.invites.find((item) => item.Invite_ID === inviteId);
  if (!invite || invite.Status !== "Pending") throw new HttpError(404, "That invite is no longer pending.");
  if (!canInviteToTeam(actor, invite.Team_ID, db.members)) throw new HttpError(403, "You cannot revoke that invite.");
  invite.Status = "Revoked";
  invite.Responded_At = nowIso();
  log(db, actor.User_ID, "invite.revoked", "team", invite.Team_ID, invite.Email, "Revoked");
  return invite;
}
function respondInvite(db, actor, inviteId, accept) {
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
function ensureAccount(db, profile, bootstrapEmail) {
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
      Access_Role: becomesAdmin ? "Admin" : "Employee"
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
function accountName(name, email) {
  const cleaned = name.trim().replace(/\s+/g, " ").replace(/[\[\]@()]/g, "");
  if (cleaned.length >= 2) return cleaned.slice(0, 80);
  const local = email.split("@")[0]?.replace(/[._-]+/g, " ").replace(/[^a-zA-Z0-9 ]/g, "").trim() || "New member";
  return local.length >= 2 ? local.slice(0, 80) : "New member";
}
function markNotifications(db, actor, ids) {
  const stamp = nowIso();
  for (const item of db.notifications) {
    if (item.Recipient_ID !== actor.User_ID || item.Read_At) continue;
    if (ids === "all" || ids.includes(item.Notification_ID)) item.Read_At = stamp;
  }
}
function placeholderAttendees(db, ids) {
  return ids.map((id) => db.users.find((user) => user.User_ID === id)).filter((user) => Boolean(user?.Email.toLowerCase().endsWith("@goyal.demo"))).map((user) => user.Name);
}

// server/push.ts
import webpush from "web-push";
function loadPushConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = process.env.VAPID_SUBJECT?.trim() || "mailto:admin@localhost";
  if (!publicKey || !privateKey) return null;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return { publicKey, privateKey, subject };
}
function createPushStore(pool) {
  return {
    async save(userId, subscription) {
      const endpoint = subscription.endpoint?.trim() ?? "";
      const p256dh = subscription.keys?.p256dh?.trim() ?? "";
      const auth = subscription.keys?.auth?.trim() ?? "";
      if (!endpoint || !p256dh || !auth) throw new Error("Invalid push subscription.");
      await pool.query(
        `INSERT INTO workspace.push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, created_at = EXCLUDED.created_at`,
        [endpoint, userId, p256dh, auth, (/* @__PURE__ */ new Date()).toISOString()]
      );
    },
    async remove(endpoint, userId) {
      if (userId) {
        await pool.query("DELETE FROM workspace.push_subscriptions WHERE endpoint = $1 AND user_id = $2", [endpoint, userId]);
      } else {
        await pool.query("DELETE FROM workspace.push_subscriptions WHERE endpoint = $1", [endpoint]);
      }
    },
    async removeAllForUser(userId) {
      await pool.query("DELETE FROM workspace.push_subscriptions WHERE user_id = $1", [userId]);
    },
    async listForUser(userId) {
      const result = await pool.query(
        "SELECT endpoint, p256dh, auth FROM workspace.push_subscriptions WHERE user_id = $1",
        [userId]
      );
      return result.rows;
    }
  };
}
function pushUrlFor(entityType, entityId) {
  if (entityType === "task") return `/?task=${encodeURIComponent(entityId)}`;
  if (entityType === "meeting") return `/calendar`;
  if (entityType === "team") return `/team`;
  if (entityType === "user") return `/chat?with=${encodeURIComponent(entityId)}`;
  return "/";
}
async function sendPushToUser(store, config, userId, title, body, entityType, entityId) {
  if (!config) return;
  const rows = await store.listForUser(userId);
  if (!rows.length) return;
  const payload = JSON.stringify({ title, body, url: pushUrlFor(entityType, entityId) });
  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          payload
        );
      } catch (error) {
        const status = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 0;
        if (status === 404 || status === 410) await store.remove(row.endpoint);
      }
    })
  );
}

// server/storage.ts
import fs from "node:fs";
import path2 from "node:path";
import { randomBytes } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
function objectKey(prefix, folder, id, name) {
  const clean = prefix.replace(/^\/+|\/+$/g, "");
  const ext = path2.extname(name).toLowerCase().replace(/[^a-z0-9.]/g, "").slice(0, 8);
  return `${clean}/${folder}/${id}${ext}`;
}
function s3Settings() {
  const bucket = process.env.S3_BUCKET?.trim() ?? "";
  const region = process.env.S3_REGION?.trim() ?? "";
  const accessKeyId = process.env.S3_ACCESS_KEY?.trim() ?? "";
  const secretAccessKey = process.env.S3_SECRET_KEY?.trim() ?? "";
  if (!bucket || !region || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    prefix: (process.env.S3_PREFIX?.trim() || "workspace").replace(/^\/+|\/+$/g, ""),
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true"
  };
}
function clientFor() {
  const settings = s3Settings();
  if (!settings) return null;
  return {
    settings,
    client: new S3Client({
      region: settings.region,
      forcePathStyle: settings.forcePathStyle,
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey }
    })
  };
}
function localPath(uploadDir, ref) {
  const root3 = path2.resolve(uploadDir);
  const full = path2.resolve(root3, path2.basename(ref));
  if (full === root3 || !full.startsWith(`${root3}${path2.sep}`)) return null;
  return full;
}
async function storeBytes(folder, name, buffer, mime, uploadDir) {
  const remote = clientFor();
  if (remote) {
    const key = objectKey(remote.settings.prefix, folder, randomBytes(16).toString("hex"), name);
    try {
      await remote.client.send(new PutObjectCommand({
        Bucket: remote.settings.bucket,
        Key: key,
        Body: buffer,
        ContentType: mime
      }));
    } catch {
      throw new HttpError(502, "Could not store that file.");
    }
    return `s3:${key}`;
  }
  const id = randomBytes(16).toString("hex");
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.writeFileSync(path2.join(uploadDir, id), buffer);
  return id;
}
async function readStored(ref, uploadDir) {
  if (ref.startsWith("s3:")) {
    const remote = clientFor();
    if (!remote) throw new HttpError(503, "File storage is not configured.");
    try {
      const result = await remote.client.send(new GetObjectCommand({ Bucket: remote.settings.bucket, Key: ref.slice(3) }));
      if (!result.Body) return null;
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      const status = error.$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw new HttpError(502, "Could not open that file.");
    }
  }
  const full = localPath(uploadDir, ref);
  if (!full || !fs.existsSync(full)) return null;
  return fs.readFileSync(full);
}
async function deleteStored(ref, uploadDir) {
  if (ref.startsWith("s3:")) {
    const remote = clientFor();
    if (!remote) return;
    await remote.client.send(new DeleteObjectCommand({ Bucket: remote.settings.bucket, Key: ref.slice(3) })).catch(() => void 0);
    return;
  }
  const full = localPath(uploadDir, ref);
  if (full) fs.rmSync(full, { force: true });
}

// server/google.ts
var FULL_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
var OWNED_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";
var EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
var FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";
var EVENTS_FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.events.freebusy";
var READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
function calendarAuthUrl(config, state) {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: `openid email profile ${OWNED_EVENTS_SCOPE} ${FREEBUSY_SCOPE}`,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}
async function tokenRequest(body) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const json = await response.json();
  if (!response.ok || !json.access_token) {
    throw new HttpError(502, json.error_description || "Google Calendar authorization failed.");
  }
  return json;
}
function exchangeAuthCode(config, code) {
  return tokenRequest(
    new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code"
    })
  );
}
function refreshAccessToken(config, refreshToken) {
  return tokenRequest(
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token"
    })
  );
}
function calendarScopesGranted(scope) {
  const granted = new Set((scope ?? "").split(/\s+/).filter(Boolean));
  if (granted.has(FULL_CALENDAR_SCOPE)) return true;
  const canWrite = granted.has(EVENTS_SCOPE) || granted.has(OWNED_EVENTS_SCOPE);
  const canReadBusy = granted.has(READONLY_SCOPE) || granted.has(FREEBUSY_SCOPE) || granted.has(EVENTS_FREEBUSY_SCOPE);
  return canWrite && canReadBusy;
}
async function googleProfile(accessToken) {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const json = await response.json();
  if (!response.ok || !json.email || json.email_verified === false) {
    throw new HttpError(401, json.error_description || "Google did not return a verified email.");
  }
  return { email: json.email.toLowerCase(), name: json.name || "" };
}
async function verifyGoogleIdToken(idToken, clientId) {
  const url = new URL("https://oauth2.googleapis.com/tokeninfo");
  url.searchParams.set("id_token", idToken);
  const response = await fetch(url);
  const json = await response.json();
  if (!response.ok || !json.email) throw new HttpError(401, "Google sign-in could not be verified.");
  if (json.aud !== clientId) throw new HttpError(401, "Google sign-in was issued for a different application.");
  if (json.email_verified !== "true" && json.email_verified !== true) {
    throw new HttpError(401, "That Google account does not have a verified email.");
  }
  return { email: json.email.toLowerCase(), name: json.name || "" };
}
function authHeaders(accessToken) {
  return { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
}
async function googleJson(response) {
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(502, json.error?.message || "Google Calendar request failed.");
  return json;
}
function responsesOf(event) {
  const allowed = /* @__PURE__ */ new Set(["accepted", "declined", "tentative", "needsAction"]);
  const responses = {};
  for (const attendee of event.attendees ?? []) {
    if (!attendee.email) continue;
    const status = attendee.responseStatus && allowed.has(attendee.responseStatus) ? attendee.responseStatus : "needsAction";
    responses[attendee.email.toLowerCase()] = status === "needsAction" ? "invited" : status;
  }
  return responses;
}
function reminderBody(minutes, online) {
  const at = minutes > 0 ? minutes : 10;
  const overrides = online ? [
    { method: "email", minutes: at },
    { method: "popup", minutes: at }
  ] : [{ method: "popup", minutes: at }];
  return { useDefault: false, overrides };
}
function eventBody(input, conference) {
  const body = {
    summary: input.title,
    description: input.description,
    location: input.meet ? input.location || "Google Meet" : input.location,
    start: { dateTime: input.start, timeZone: "Asia/Kolkata" },
    end: { dateTime: input.end, timeZone: "Asia/Kolkata" },
    attendees: input.emails.map((email) => ({ email })),
    transparency: "opaque",
    reminders: reminderBody(input.reminderMinutes, input.meet)
  };
  if (conference === "create") {
    body.conferenceData = {
      createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } }
    };
  }
  if (conference === "remove") body.conferenceData = null;
  return body;
}
function eventResult(event) {
  const meet = event.conferenceData?.entryPoints?.find((point) => point.entryPointType === "video")?.uri || event.hangoutLink || "";
  return {
    eventId: event.id || "",
    htmlLink: event.htmlLink || "",
    meetLink: meet,
    responses: responsesOf(event)
  };
}
async function queryFreeBusy(accessToken, timeMin, timeMax, emails) {
  const response = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify({ timeMin, timeMax, items: emails.map((id) => ({ id })) })
  });
  const json = await googleJson(response);
  return json.calendars ?? {};
}
async function createCalendarEvent(accessToken, input) {
  const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all", {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify(eventBody(input, input.meet ? "create" : "keep"))
  });
  const created = eventResult(await googleJson(response));
  if (input.meet && !created.meetLink) throw new HttpError(502, "Google Calendar did not return a Meet link.");
  if (!input.meet) created.meetLink = "";
  return created;
}
async function updateCalendarEvent(accessToken, eventId, input) {
  const conference = input.meet ? input.hadMeetLink ? "keep" : "create" : "remove";
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=all`,
    {
      method: "PATCH",
      headers: authHeaders(accessToken),
      body: JSON.stringify(eventBody(input, conference))
    }
  );
  const updated = eventResult(await googleJson(response));
  if (input.meet && !updated.meetLink) throw new HttpError(502, "Google Calendar did not return a Meet link.");
  if (!input.meet) updated.meetLink = "";
  return updated;
}
async function deleteCalendarEvent(accessToken, eventId) {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
    { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (response.status === 404 || response.status === 410) return;
  if (!response.ok) {
    const json = await response.json().catch(() => ({}));
    throw new HttpError(502, json.error?.message || "Google Calendar could not cancel the event.");
  }
}
async function getCalendarEvent(accessToken, eventId) {
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (response.status === 404 || response.status === 410) {
    throw new HttpError(404, "This event is no longer on Google Calendar.");
  }
  const event = await googleJson(response);
  return {
    ...eventResult(event),
    status: event.status || "confirmed",
    start: event.start?.dateTime || "",
    end: event.end?.dateTime || "",
    location: event.location || ""
  };
}

// server/security.ts
function securityHeaders(secure) {
  return (_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'"
      ].join("; ")
    );
    if (secure) res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    next();
  };
}
function createRateLimiter(limit, windowMs) {
  const hits = /* @__PURE__ */ new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((stamp) => now - stamp < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 8e3) {
      for (const [entry, stamps] of hits) {
        if (stamps.every((stamp) => now - stamp >= windowMs)) hits.delete(entry);
      }
    }
    return true;
  };
}
function csvCell(value) {
  const text2 = value.replace(/\r?\n/g, " ");
  const guarded = /^[=+\-@]/.test(text2) ? `'${text2}` : text2;
  if (/[",]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}
function fileSignatureMatches(buffer, mime) {
  if (buffer.length < 4) return false;
  if (mime === "image/png") return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg") return buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (mime === "image/gif") {
    const header = buffer.subarray(0, 6).toString("ascii");
    return header === "GIF87a" || header === "GIF89a";
  }
  if (mime === "image/webp") return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  if (mime === "application/pdf") return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  if (mime === "text/plain" || mime === "text/csv") return !buffer.includes(0);
  if (mime.startsWith("application/vnd.openxmlformats")) return buffer[0] === 80 && buffer[1] === 75;
  return false;
}

// server/app.ts
var ALLOWED_FILES = /* @__PURE__ */ new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation"
]);
function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}
function signState(secret, userId, nonce) {
  const body = `${userId}.${Date.now() + 10 * 60 * 1e3}.${nonce}`;
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyState(secret, state) {
  const parts = state.split(".");
  const sig = parts.pop() ?? "";
  const body = parts.join(".");
  const [userId, exp, nonce] = body.split(".");
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right) || Number(exp) < Date.now() || !userId || !nonce) {
    throw new HttpError(400, "The Google sign-in expired. Try again.");
  }
  return { userId, nonce };
}
function readCookie(header, name) {
  if (!header) return "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}
function createApp(deps) {
  const { config, store, sessions, tokens, uploadDir, versions, pushStore } = deps;
  fs2.mkdirSync(uploadDir, { recursive: true });
  const pushConfig = loadPushConfig();
  setPushDispatch(
    pushStore ? (recipientId, title, body, entityType, entityId) => {
      void sendPushToUser(pushStore, pushConfig, recipientId, title, body, entityType, entityId);
    } : null
  );
  async function storedFile(input, folder) {
    if (!input.Content_Base64) return void 0;
    if (!ALLOWED_FILES.has(input.Mime_Type)) throw new HttpError(400, "This file type is not allowed.");
    const buffer = Buffer.from(input.Content_Base64, "base64");
    if (!buffer.length || buffer.length > 4e6) throw new HttpError(400, "Attachments must be under 4 MB.");
    if (!fileSignatureMatches(buffer, input.Mime_Type)) throw new HttpError(400, "The file contents do not match the declared type.");
    const storage = await storeBytes(folder, input.File_Name, buffer, input.Mime_Type, uploadDir);
    return { File_Name: input.File_Name, Mime_Type: input.Mime_Type, Size_Bytes: buffer.length, Storage_Ref: storage };
  }
  function sendDownload(res, name, mime, bytes) {
    const safe = (name || "file").replace(/[^\w.\- ()]+/g, "_");
    res.setHeader("Content-Type", ALLOWED_FILES.has(mime) ? mime : "application/octet-stream");
    res.setHeader("Content-Disposition", `${mime.startsWith("image/") ? "inline" : "attachment"}; filename="${safe}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.send(bytes);
  }
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy ? 1 : false);
  app.use(express.json({ limit: "8mb" }));
  app.use(securityHeaders(config.cookieSecure));
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  const limitAuth = createRateLimiter(30, 10 * 60 * 1e3);
  const limitApi = createRateLimiter(240, 60 * 1e3);
  let chain = Promise.resolve();
  function localLock(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  const locked = deps.lock ?? localLock;
  function mutate(fn) {
    return locked(async () => {
      const db = await store.read();
      const outcome = await fn(db);
      await store.write(outcome.db);
      return outcome.result;
    });
  }
  function readDb(fn) {
    return locked(async () => fn(await store.read()));
  }
  function cookieSuffix() {
    return config.cookieSecure ? "; Secure" : "";
  }
  async function setSession(res, userId) {
    const token = randomBytes2(32).toString("base64url");
    const mine = (await sessions.listByUser(userId)).filter((item) => item.expiresAt > (/* @__PURE__ */ new Date()).toISOString());
    const expiring = mine.slice(0, Math.max(0, mine.length - 7));
    for (const old of expiring) await sessions.delete(old.tokenHash);
    const record = {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + 7 * 864e5).toISOString()
    };
    await sessions.put(record);
    res.append("Set-Cookie", `mops_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${cookieSuffix()}`);
  }
  async function clearSession(res, token) {
    if (token) await sessions.delete(hashToken(token));
    res.append("Set-Cookie", `mops_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${cookieSuffix()}`);
  }
  function setOauthNonce(res, nonce) {
    res.append("Set-Cookie", `mops_oauth=${encodeURIComponent(nonce)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${cookieSuffix()}`);
  }
  function clearOauthNonce(res) {
    res.append("Set-Cookie", `mops_oauth=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${cookieSuffix()}`);
  }
  async function accessTokenFor(userId) {
    const record = await tokens.get(userId);
    if (!record?.refreshToken || !config.googleClientSecret) return null;
    if (record.scopes && !calendarScopesGranted(record.scopes)) return null;
    if (record.accessToken && record.expiresAt > new Date(Date.now() + 6e4).toISOString()) return record.accessToken;
    const refreshed = await refreshAccessToken(
      { clientId: config.googleClientId, clientSecret: config.googleClientSecret, redirectUri: config.googleRedirectUri },
      record.refreshToken
    );
    record.accessToken = refreshed.access_token || "";
    record.expiresAt = new Date(Date.now() + (refreshed.expires_in ?? 3600) * 1e3).toISOString();
    await tokens.put(record);
    return record.accessToken;
  }
  app.use("/api", async (req, res, next) => {
    try {
      if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method) && req.get("x-requested-with") !== "fetch") {
        res.status(403).json({ error: "Forbidden." });
        return;
      }
      const token = readCookie(req.headers.cookie, "mops_session");
      if (token) {
        const session = await sessions.get(hashToken(token));
        if (session && session.expiresAt > (/* @__PURE__ */ new Date()).toISOString()) {
          const db = await store.read();
          const user = db.users.find((item) => item.User_ID === session.userId && item.Status === "Active");
          if (user) req.user = user;
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  });
  app.use("/api", async (req, res, next) => {
    try {
      const full = req.originalUrl.split("?")[0];
      if (full === "/api/health") {
        next();
        return;
      }
      const key = req.user ? `user:${req.user.User_ID}` : `ip:${req.ip || req.socket.remoteAddress || "unknown"}`;
      const authRoute = full.startsWith("/api/auth") || full.startsWith("/api/google");
      const bucket = authRoute ? "auth" : "api";
      const allowed = deps.allow ? await deps.allow(key, bucket) : authRoute ? limitAuth(key) : limitApi(key);
      if (!allowed) {
        res.setHeader("Retry-After", "60");
        res.status(429).json({ error: "Too many requests. Wait a minute and try again." });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  });
  const route = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
  const authed = (fn) => route(async (req, res) => {
    if (!req.user) throw new HttpError(401, "Sign in required.");
    const openWhileWaiting = req.path === "/api/bootstrap" || req.path === "/api/me" || /\/api\/invites\/[^/]+\/respond$/.test(req.path);
    if (!openWhileWaiting) {
      const allowed = await readDb((db) => hasWorkspaceAccess(db, req.user));
      if (!allowed) throw new HttpError(403, "Accept an invite before opening the workspace.");
    }
    return fn(req, res);
  });
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/api/system", (_req, res) => {
    res.json(systemInfo(config, store.kind));
  });
  app.post(
    "/api/auth/google",
    route(async (req, res) => {
      if (!config.googleClientId) throw new HttpError(503, "Google Sign-In is not configured.");
      const credential = String(req.body?.credential || "");
      const identity = await verifyGoogleIdToken(credential, config.googleClientId);
      const user = await mutate((db) => ({ db, result: ensureAccount(db, identity, config.bootstrapAdminEmail) }));
      await setSession(res, user.User_ID);
      res.json({ user });
    })
  );
  app.post(
    "/api/auth/logout",
    route(async (req, res) => {
      await clearSession(res, readCookie(req.headers.cookie, "mops_session"));
      res.json({ ok: true });
    })
  );
  async function snapshotFor(user, db, dbVersion) {
    const google = await tokens.get(user.User_ID);
    return {
      ...visibleData(db, user),
      ...systemInfo(config, store.kind),
      dbVersion,
      me: user,
      calendarConnected: Boolean(google?.refreshToken && (!google.scopes || calendarScopesGranted(google.scopes)))
    };
  }
  app.get(
    "/api/bootstrap",
    authed(async (req, res) => {
      await mutate(async (db) => {
        ensureDerivedNotifications(db, req.user.User_ID);
        return { db, result: null };
      });
      const dbVersion = await versions.get();
      res.json(await readDb((db) => snapshotFor(req.user, db, dbVersion)));
    })
  );
  app.get(
    "/api/sync",
    authed(async (req, res) => {
      const clientVersion = String(req.query.v || "");
      const current = await versions.get();
      if (clientVersion && clientVersion === current) {
        res.json({ unchanged: true, dbVersion: current });
        return;
      }
      res.json(await readDb((db) => snapshotFor(req.user, db, current)));
    })
  );
  app.post(
    "/api/tasks",
    authed(async (req, res) => {
      const input = createTaskSchema.parse(req.body);
      const task = await mutate((db) => ({ db, result: createTask(db, req.user, input) }));
      res.status(201).json({ task });
    })
  );
  app.post(
    "/api/tasks/bulk",
    authed(async (req, res) => {
      const input = bulkSchema.parse(req.body);
      if (!input.Priority && !input.to) throw new HttpError(400, "Choose a priority or a status.");
      const tasks = await mutate((db) => ({ db, result: bulkUpdate(db, req.user, input.ids, input) }));
      res.json({ tasks });
    })
  );
  app.patch(
    "/api/tasks/:id",
    authed(async (req, res) => {
      const input = updateTaskSchema.parse(req.body);
      const task = await mutate((db) => ({ db, result: updateTask(db, req.user, req.params.id, input) }));
      res.json({ task });
    })
  );
  app.post(
    "/api/tasks/:id/transition",
    authed(async (req, res) => {
      const input = transitionSchema.parse(req.body);
      const task = await mutate((db) => ({ db, result: transitionTask(db, req.user, req.params.id, input.to, input.reason, input.Updated_At) }));
      res.json({ task });
    })
  );
  app.post(
    "/api/tasks/:id/comments",
    authed(async (req, res) => {
      const input = commentSchema.parse(req.body);
      const comment = await mutate((db) => ({ db, result: addComment(db, req.user, req.params.id, input.Body) }));
      res.status(201).json({ comment });
    })
  );
  app.post(
    "/api/tasks/:id/attachments",
    authed(async (req, res) => {
      const input = attachmentSchema.parse(req.body);
      const file = await storedFile(input, "tasks");
      if (!file) throw new HttpError(400, "Choose a file.");
      try {
        const attachment = await mutate((db) => {
          const saved = addAttachment(db, req.user, req.params.id, { name: file.File_Name, mime: file.Mime_Type, size: file.Size_Bytes, storage: file.Storage_Ref });
          return { db, result: saved };
        });
        res.status(201).json({ attachment });
      } catch (error) {
        await deleteStored(file.Storage_Ref, uploadDir);
        throw error;
      }
    })
  );
  app.get(
    "/api/attachments/:id",
    authed(async (req, res) => {
      const file = await readDb((db) => {
        const attachment = db.attachments.find((item) => item.Attachment_ID === req.params.id);
        if (!attachment) throw new HttpError(404, "Attachment not found.");
        const task = db.tasks.find((item) => item.Task_ID === attachment.Task_ID);
        if (!task || !visibleData(db, req.user).tasks.some((item) => item.Task_ID === task.Task_ID)) {
          throw new HttpError(403, "You cannot download this file.");
        }
        return attachment;
      });
      const bytes = await readStored(file.Storage_Ref, uploadDir);
      if (!bytes) throw new HttpError(404, "The file is no longer available.");
      sendDownload(res, file.File_Name, file.Mime_Type, bytes);
    })
  );
  async function googleForMeeting(actor, organizerId) {
    return await accessTokenFor(organizerId) || (organizerId !== actor.User_ID ? accessTokenFor(actor.User_ID) : null);
  }
  app.post(
    "/api/meetings",
    authed(async (req, res) => {
      const input = meetingSchema.parse(req.body);
      const prepared = await readDb((db) => {
        if (!hasWorkspaceAccess(db, req.user)) throw new HttpError(403, "Accept an invite before opening the workspace.");
        const ids = Array.from(/* @__PURE__ */ new Set([req.user.User_ID, ...input.Attendees]));
        const placeholders = placeholderAttendees(db, ids);
        if (placeholders.length) throw new HttpError(400, `Replace placeholder emails before scheduling: ${placeholders.join(", ")}.`);
        for (const id of ids) {
          const person = db.users.find((user) => user.User_ID === id);
          if (!person || person.Status !== "Active") throw new HttpError(400, "Every attendee must be an active person in the workspace.");
        }
        return { emails: ids.map((id) => db.users.find((user) => user.User_ID === id)?.Email || "").filter(Boolean) };
      });
      const token = await accessTokenFor(req.user.User_ID);
      if (!token) throw new HttpError(409, "Sign in with Google Calendar access before scheduling. The meeting is not saved until Google accepts it.");
      const online = input.Format === "Online";
      const google = await createCalendarEvent(token, {
        title: input.Meeting_Title,
        description: input.Description,
        location: input.Location,
        start: kolkataToIso(input.Date, input.Start_Time),
        end: kolkataToIso(input.Date, input.End_Time),
        emails: prepared.emails,
        meet: online,
        reminderMinutes: input.Reminder_Minutes
      });
      try {
        const meeting = await mutate((db) => ({ db, result: createMeeting(db, req.user, input, google) }));
        const calendarWarning = online ? "Google Meet link created. Everyone was added to the calendar and will get a reminder to join." : "The time is blocked on the calendar. No Meet link was created.";
        res.status(201).json({ meeting, calendarWarning });
      } catch (error) {
        if (google.eventId) await deleteCalendarEvent(token, google.eventId).catch(() => void 0);
        throw error;
      }
    })
  );
  app.patch(
    "/api/meetings/:id",
    authed(async (req, res) => {
      const input = meetingSchema.parse(req.body);
      if (!input.Updated_At) throw new HttpError(400, "Refresh the meeting and try again.");
      const prepared = await readDb((db) => {
        const current = db.meetings.find((item) => item.Meeting_ID === req.params.id);
        if (!current) throw new HttpError(404, "Meeting not found.");
        if (!canManageMeeting(req.user, current, db)) throw new HttpError(403, "You cannot change this meeting.");
        if (current.Updated_At !== input.Updated_At) throw new HttpError(409, "This was updated by someone else. Refresh and try again.");
        const ids = Array.from(/* @__PURE__ */ new Set([current.Organized_By, ...input.Attendees]));
        return {
          organizerId: current.Organized_By,
          eventId: current.Calendar_Event_ID,
          hadMeetLink: Boolean(current.Google_Meet_Link),
          emails: ids.map((id) => db.users.find((user) => user.User_ID === id)?.Email || "").filter(Boolean)
        };
      });
      const token = await googleForMeeting(req.user, prepared.organizerId);
      if (!token) throw new HttpError(409, "Connect Google Calendar before changing this meeting.");
      const online = input.Format === "Online";
      const eventInput = {
        title: input.Meeting_Title,
        description: input.Description,
        location: input.Location,
        start: kolkataToIso(input.Date, input.Start_Time),
        end: kolkataToIso(input.Date, input.End_Time),
        emails: prepared.emails,
        meet: online,
        reminderMinutes: input.Reminder_Minutes
      };
      const google = prepared.eventId ? await updateCalendarEvent(token, prepared.eventId, { ...eventInput, hadMeetLink: prepared.hadMeetLink }) : await createCalendarEvent(token, eventInput);
      const meeting = await mutate((db) => ({ db, result: updateMeeting(db, req.user, req.params.id, { ...input, Updated_At: input.Updated_At || "" }, google) }));
      res.json({ meeting });
    })
  );
  app.post(
    "/api/meetings/:id/cancel",
    authed(async (req, res) => {
      const expected = String(req.body?.Updated_At || "");
      const prepared = await readDb((db) => {
        const current = db.meetings.find((item) => item.Meeting_ID === req.params.id);
        if (!current) throw new HttpError(404, "Meeting not found.");
        if (!canManageMeeting(req.user, current, db)) throw new HttpError(403, "You cannot change this meeting.");
        return { organizerId: current.Organized_By, eventId: current.Status === "Cancelled" ? "" : current.Calendar_Event_ID };
      });
      if (prepared.eventId) {
        const token = await googleForMeeting(req.user, prepared.organizerId);
        if (!token) throw new HttpError(409, "Connect Google Calendar before cancelling a meeting that is already on Google Calendar.");
        await deleteCalendarEvent(token, prepared.eventId);
      }
      const meeting = await mutate((db) => ({ db, result: cancelMeeting(db, req.user, req.params.id, expected) }));
      res.json({ meeting });
    })
  );
  app.post(
    "/api/meetings/:id/sync",
    authed(async (req, res) => {
      const prepared = await readDb((db) => {
        const current = db.meetings.find((item) => item.Meeting_ID === req.params.id);
        if (!current?.Calendar_Event_ID) throw new HttpError(400, "This meeting is not linked to Google Calendar yet.");
        if (!canManageMeeting(req.user, current, db)) throw new HttpError(403, "You cannot change this meeting.");
        return { organizerId: current.Organized_By, eventId: current.Calendar_Event_ID };
      });
      const token = await googleForMeeting(req.user, prepared.organizerId);
      if (!token) throw new HttpError(409, "Connect Google Calendar to refresh this meeting.");
      const google = await getCalendarEvent(token, prepared.eventId);
      const meeting = await mutate((db) => ({ db, result: syncMeeting(db, req.user, req.params.id, google) }));
      res.json({ meeting });
    })
  );
  app.post(
    "/api/meetings/:id/respond",
    authed(async (req, res) => {
      const response = req.body?.response;
      if (response !== "accepted" && response !== "declined" && response !== "tentative") throw new HttpError(400, "Choose accept, reject, or postpone.");
      const meeting = await mutate((db) => ({ db, result: respondMeeting(db, req.user, req.params.id, response) }));
      res.json({ meeting });
    })
  );
  app.post(
    "/api/calendar/availability",
    authed(async (req, res) => {
      const attendeeIds = Array.isArray(req.body?.attendeeIds) ? req.body.attendeeIds.map(String) : [];
      const start = String(req.body?.start || "");
      const end = String(req.body?.end || "");
      if (!attendeeIds.length || !start || !end || start >= end) throw new HttpError(400, "Choose attendees and a valid time.");
      const snapshot = await readDb((db) => ({
        db,
        emails: attendeeIds.map((id) => db.users.find((user) => user.User_ID === id)?.Email.toLowerCase() || "").filter(Boolean)
      }));
      const external = {};
      let warning = "";
      const token = await accessTokenFor(req.user.User_ID);
      if (!token) {
        warning = "Google Calendar is not connected. People are marked unknown unless they already have a meeting in this workspace.";
      } else {
        try {
          const calendars = await queryFreeBusy(token, new Date(start).toISOString(), new Date(end).toISOString(), snapshot.emails);
          for (const email of snapshot.emails) external[email] = interpretGoogleEntry(calendars[email]);
        } catch (error) {
          warning = error instanceof Error ? error.message : "Google Calendar could not be checked.";
        }
      }
      res.json({
        people: availabilityFor(snapshot.db, attendeeIds, new Date(start).toISOString(), new Date(end).toISOString(), external),
        warning,
        live: Boolean(token) && !warning
      });
    })
  );
  app.post(
    "/api/calendar/slots",
    authed(async (req, res) => {
      const attendeeIds = Array.isArray(req.body?.attendeeIds) ? req.body.attendeeIds.map(String) : [];
      const day2 = String(req.body?.day || "");
      const durationMinutes = Number(req.body?.durationMinutes || 30);
      if (!attendeeIds.length || !/^\d{4}-\d{2}-\d{2}$/.test(day2)) throw new HttpError(400, "Choose attendees and a date.");
      const snapshot = await readDb((db) => ({
        db,
        emails: attendeeIds.map((id) => db.users.find((user) => user.User_ID === id)?.Email.toLowerCase() || "").filter(Boolean)
      }));
      const externalBusy = [];
      let confirmed = true;
      let warning = "";
      const token = await accessTokenFor(req.user.User_ID);
      const rangeStart = kolkataToIso(day2, "00:00");
      const rangeEnd = kolkataToIso(day2, "23:59");
      if (!token) {
        confirmed = false;
        warning = "Suggestions avoid meetings already in this workspace. External calendars are not connected, so these times are not confirmed.";
      } else {
        try {
          const calendars = await queryFreeBusy(token, rangeStart, rangeEnd, snapshot.emails);
          for (const email of snapshot.emails) {
            const entry = interpretGoogleEntry(calendars[email]);
            if (entry.state === "unknown") confirmed = false;
            if (entry.state === "busy") externalBusy.push(...entry.windows);
          }
        } catch (error) {
          confirmed = false;
          warning = error instanceof Error ? error.message : "Google Calendar could not be checked.";
        }
      }
      res.json({ slots: slotsFor(snapshot.db, attendeeIds, day2, durationMinutes, externalBusy, confirmed), warning, confirmed });
    })
  );
  app.get(
    "/api/export/work",
    authed(async (req, res) => {
      const csv = await readDb((db) => {
        const visible = visibleData(db, req.user);
        const names = new Map(db.users.map((user) => [user.User_ID, user.Name]));
        const teams = new Map(db.teams.map((team) => [team.Team_ID, team.Name]));
        const header = ["Key", "Type", "Title", "Status", "Priority", "Severity", "Team", "Project", "Assignee", "Due", "Labels"];
        const lines = [header.join(",")];
        for (const task of visible.tasks) {
          lines.push([
            task.Key,
            task.Type,
            task.Task_Title,
            task.Status,
            task.Priority,
            task.Severity,
            teams.get(task.Team_ID) || "",
            task.Project,
            names.get(task.Assigned_To) || "",
            task.Due_Date,
            task.Labels
          ].map(csvCell).join(","));
        }
        return lines.join("\r\n");
      });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="goyal-work.csv"');
      res.send(csv);
    })
  );
  app.patch(
    "/api/me",
    authed(async (req, res) => {
      const input = profileNameSchema.parse(req.body);
      const user = await mutate((db) => ({ db, result: renameSelf(db, req.user, input.Name) }));
      res.json({ user });
    })
  );
  app.post(
    "/api/teams",
    authed(async (req, res) => {
      const input = teamSchema.parse(req.body);
      const team = await mutate((db) => ({ db, result: createTeam(db, req.user, input) }));
      res.status(201).json({ team });
    })
  );
  app.patch(
    "/api/teams/:id",
    authed(async (req, res) => {
      const input = teamSchema.pick({ Name: true }).parse(req.body);
      const team = await mutate((db) => ({ db, result: renameTeam(db, req.user, req.params.id, input.Name) }));
      res.json({ team });
    })
  );
  app.delete(
    "/api/teams/:id",
    authed(async (req, res) => {
      const outcome = await mutate((db) => ({ db, result: deleteTeam(db, req.user, req.params.id) }));
      for (const ref of outcome.storageRefs) {
        await deleteStored(ref, uploadDir).catch(() => void 0);
      }
      res.json({ ok: true, teamId: outcome.teamId });
    })
  );
  app.get(
    "/api/push/vapid-public-key",
    authed(async (_req, res) => {
      res.json({ publicKey: config.vapidPublicKey || "", ready: Boolean(config.vapidPublicKey && config.vapidPrivateKey) });
    })
  );
  app.post(
    "/api/push/subscribe",
    authed(async (req, res) => {
      if (!pushStore || !config.vapidPublicKey || !config.vapidPrivateKey) throw new HttpError(503, "Push notifications are not configured on the server.");
      const endpoint = String(req.body?.endpoint || "");
      const p256dh = String(req.body?.keys?.p256dh || "");
      const auth = String(req.body?.keys?.auth || "");
      if (!endpoint || !p256dh || !auth) throw new HttpError(400, "Invalid push subscription.");
      await pushStore.save(req.user.User_ID, { endpoint, keys: { p256dh, auth } });
      res.status(201).json({ ok: true });
    })
  );
  app.delete(
    "/api/push/subscribe",
    authed(async (req, res) => {
      if (!pushStore) throw new HttpError(503, "Push notifications are not configured on the server.");
      const endpoint = String(req.body?.endpoint || "");
      if (endpoint) await pushStore.remove(endpoint, req.user.User_ID);
      else await pushStore.removeAllForUser(req.user.User_ID);
      res.json({ ok: true });
    })
  );
  app.post(
    "/api/teams/:id/messages",
    authed(async (req, res) => {
      const input = workspaceMessageSchema.parse(req.body);
      const file = await storedFile(input, "chat");
      try {
        const message = await mutate((db) => ({ db, result: postWorkspaceMessage(db, req.user, req.params.id, input.Body, file) }));
        res.status(201).json({ message });
      } catch (error) {
        if (file) await deleteStored(file.Storage_Ref, uploadDir);
        throw error;
      }
    })
  );
  app.get(
    "/api/messages",
    authed(async (req, res) => {
      const messages = await readDb((db) => visibleData(db, req.user).messages);
      res.json({ messages });
    })
  );
  app.post(
    "/api/messages",
    authed(async (req, res) => {
      const input = directMessageSchema.parse(req.body);
      const file = await storedFile(input, "chat");
      try {
        const message = await mutate((db) => ({ db, result: postDirectMessage(db, req.user, input.Recipient_ID, input.Body, file) }));
        res.status(201).json({ message });
      } catch (error) {
        if (file) await deleteStored(file.Storage_Ref, uploadDir);
        throw error;
      }
    })
  );
  app.get(
    "/api/messages/:id/file",
    authed(async (req, res) => {
      const file = await readDb((db) => {
        const message = visibleData(db, req.user).messages.find((item) => item.Message_ID === req.params.id && item.Storage_Ref);
        if (!message) throw new HttpError(404, "That file was not found.");
        return message;
      });
      const bytes = await readStored(file.Storage_Ref, uploadDir);
      if (!bytes) throw new HttpError(404, "The file is no longer available.");
      sendDownload(res, file.File_Name, file.Mime_Type, bytes);
    })
  );
  app.post(
    "/api/projects",
    authed(async (req, res) => {
      const input = projectSchema.parse(req.body);
      const project = await mutate((db) => ({ db, result: createProject(db, req.user, input) }));
      res.status(201).json({ project });
    })
  );
  app.post(
    "/api/teams/:id/members",
    authed(async (req, res) => {
      const input = addMemberSchema.parse(req.body);
      const member = await mutate((db) => ({ db, result: addTeamMember(db, req.user, req.params.id, input.User_ID, input.Member_Role) }));
      res.status(201).json({ member });
    })
  );
  app.post(
    "/api/invites",
    authed(async (req, res) => {
      const input = inviteSchema.parse(req.body);
      const invite = await mutate((db) => ({ db, result: createInvite(db, req.user, input) }));
      res.status(201).json({ invite });
    })
  );
  app.post(
    "/api/invites/:id/revoke",
    authed(async (req, res) => {
      const invite = await mutate((db) => ({ db, result: revokeInvite(db, req.user, req.params.id) }));
      res.json({ invite });
    })
  );
  app.post(
    "/api/invites/:id/respond",
    authed(async (req, res) => {
      const input = respondInviteSchema.parse(req.body);
      const invite = await mutate((db) => ({ db, result: respondInvite(db, req.user, req.params.id, input.accept) }));
      res.json({ invite });
    })
  );
  app.post(
    "/api/users",
    authed(async (req, res) => {
      const input = userSchema.parse(req.body);
      const user = await mutate((db) => ({ db, result: saveUser(db, req.user, input) }));
      res.status(201).json({ user });
    })
  );
  app.patch(
    "/api/users/:id",
    authed(async (req, res) => {
      const input = userSchema.parse(req.body);
      const user = await mutate((db) => ({ db, result: saveUser(db, req.user, { ...input, User_ID: req.params.id }) }));
      res.json({ user });
    })
  );
  app.post(
    "/api/notifications/read",
    authed(async (req, res) => {
      const ids = req.body?.all ? "all" : Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
      await mutate((db) => {
        markNotifications(db, req.user, ids);
        return { db, result: true };
      });
      res.json({ ok: true });
    })
  );
  app.put(
    "/api/settings",
    authed(async (req, res) => {
      const input = settingsSchema.parse(req.body);
      await mutate((db) => {
        updateSettings(db, req.user, input);
        return { db, result: true };
      });
      res.json({ ok: true });
    })
  );
  async function rememberGoogleToken(userId, exchanged) {
    const previous = await tokens.get(userId);
    const refreshToken = exchanged.refresh_token || previous?.refreshToken;
    if (!refreshToken) return false;
    const record = {
      userId,
      refreshToken,
      accessToken: exchanged.access_token || "",
      expiresAt: new Date(Date.now() + (exchanged.expires_in ?? 3600) * 1e3).toISOString(),
      scopes: exchanged.scope || previous?.scopes || ""
    };
    await tokens.put(record);
    return true;
  }
  app.get(
    "/api/auth/google/start",
    route(async (_req, res) => {
      if (!config.googleClientId || !config.googleClientSecret) throw new HttpError(503, "Google sign-in is not configured.");
      const nonce = randomBytes2(16).toString("base64url");
      setOauthNonce(res, nonce);
      res.redirect(calendarAuthUrl(
        { clientId: config.googleClientId, clientSecret: config.googleClientSecret, redirectUri: config.googleRedirectUri },
        signState(config.sessionSecret, "login", nonce)
      ));
    })
  );
  app.get(
    "/api/google/calendar/connect",
    route(async (req, res) => {
      if (!req.user) {
        res.redirect("/login");
        return;
      }
      if (!config.googleClientId || !config.googleClientSecret) throw new HttpError(503, "Google Calendar is not configured on the server.");
      const nonce = randomBytes2(16).toString("base64url");
      setOauthNonce(res, nonce);
      res.redirect(calendarAuthUrl(
        { clientId: config.googleClientId, clientSecret: config.googleClientSecret, redirectUri: config.googleRedirectUri },
        signState(config.sessionSecret, req.user.User_ID, nonce)
      ));
    })
  );
  app.get(
    "/api/google/calendar/callback",
    route(async (req, res) => {
      let userId = "";
      let nonce = "";
      try {
        const parsed = verifyState(config.sessionSecret, String(req.query.state || ""));
        userId = parsed.userId;
        nonce = parsed.nonce;
      } catch {
        res.redirect("/login?error=calendar");
        return;
      }
      if (readCookie(req.headers.cookie, "mops_oauth") !== nonce) {
        res.redirect("/login?error=calendar");
        return;
      }
      clearOauthNonce(res);
      const exchanged = await exchangeAuthCode(
        { clientId: config.googleClientId, clientSecret: config.googleClientSecret, redirectUri: config.googleRedirectUri },
        String(req.query.code || "")
      );
      if (userId === "login") {
        if (!exchanged.access_token) {
          res.redirect("/login?error=calendar");
          return;
        }
        const profile = await googleProfile(exchanged.access_token);
        let user;
        try {
          user = await mutate((db) => ({ db, result: ensureAccount(db, profile, config.bootstrapAdminEmail) }));
        } catch {
          res.redirect("/login?error=unknown");
          return;
        }
        const saved = await rememberGoogleToken(user.User_ID, exchanged);
        await setSession(res, user.User_ID);
        const access = await readDb((db) => hasWorkspaceAccess(db, user));
        if (!saved || !calendarScopesGranted(exchanged.scope)) {
          res.redirect(access ? "/settings?calendar=missing" : "/");
          return;
        }
        res.redirect("/");
        return;
      }
      if (!req.user || req.user.User_ID !== userId) {
        res.redirect("/login?error=calendar");
        return;
      }
      if (!await rememberGoogleToken(userId, exchanged) || !calendarScopesGranted(exchanged.scope)) {
        res.redirect("/settings?calendar=missing");
        return;
      }
      res.redirect("/settings?calendar=connected");
    })
  );
  app.post(
    "/api/google/calendar/disconnect",
    authed(async (req, res) => {
      await tokens.delete(req.user.User_ID);
      res.json({ ok: true });
    })
  );
  const dist = path3.resolve(uploadDir, "..", "..", "dist");
  if (fs2.existsSync(path3.join(dist, "index.html"))) {
    app.use(express.static(dist));
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      if (req.path.startsWith("/api")) return next();
      res.sendFile(path3.join(dist, "index.html"));
    });
  }
  app.use((error, _req, res, _next) => {
    if (error instanceof ZodError) {
      res.status(400).json({ error: zodMessage(error) });
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error(error);
    res.status(500).json({ error: "Something went wrong." });
  });
  return app;
}

// server/postgres.ts
import { randomBytes as randomBytes3 } from "node:crypto";
var SCHEMA = `
CREATE SCHEMA IF NOT EXISTS workspace;
CREATE TABLE IF NOT EXISTS workspace.users (
  position integer NOT NULL,
  user_id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  department text NOT NULL,
  role text NOT NULL,
  reports_to text NOT NULL,
  status text NOT NULL,
  access_role text NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace.teams (
  position integer NOT NULL,
  team_id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL,
  status text NOT NULL,
  created_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace.team_members (
  position integer NOT NULL,
  team_id text NOT NULL,
  user_id text NOT NULL,
  member_role text NOT NULL,
  status text NOT NULL,
  joined_at text NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE TABLE IF NOT EXISTS workspace.projects (
  position integer NOT NULL,
  project_id text PRIMARY KEY,
  team_id text NOT NULL,
  name text NOT NULL,
  key text NOT NULL,
  next_number integer NOT NULL,
  status text NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace.invites (
  position integer NOT NULL,
  invite_id text PRIMARY KEY,
  email text NOT NULL,
  team_id text NOT NULL,
  access_role text NOT NULL,
  member_role text NOT NULL,
  invited_by text NOT NULL,
  status text NOT NULL,
  created_at text NOT NULL,
  responded_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace.tasks (
  position integer NOT NULL,
  task_id text PRIMARY KEY,
  task_title text NOT NULL,
  description text NOT NULL,
  assigned_to text NOT NULL,
  assigned_by text NOT NULL,
  priority text NOT NULL,
  status text NOT NULL,
  start_date text NOT NULL,
  due_date text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  completed_at text NOT NULL,
  remarks text NOT NULL,
  project text NOT NULL,
  department text NOT NULL,
  type text NOT NULL,
  team_id text NOT NULL,
  project_id text NOT NULL,
  key text NOT NULL,
  severity text NOT NULL,
  labels text NOT NULL,
  cc_user_ids text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS workspace.task_workflows (
  position integer NOT NULL,
  task_id text PRIMARY KEY,
  reviewer_id text NOT NULL,
  blocked_reason text NOT NULL,
  review_note text NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace.comments (
  position integer NOT NULL,
  comment_id text PRIMARY KEY,
  task_id text NOT NULL,
  author_id text NOT NULL,
  body text NOT NULL,
  created_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace.attachments (
  position integer NOT NULL,
  attachment_id text PRIMARY KEY,
  task_id text NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL,
  uploaded_by text NOT NULL,
  uploaded_at text NOT NULL,
  storage_ref text NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace.meetings (
  position integer NOT NULL,
  meeting_id text PRIMARY KEY,
  meeting_title text NOT NULL,
  description text NOT NULL,
  organized_by text NOT NULL,
  attendees text NOT NULL,
  start_datetime text NOT NULL,
  end_datetime text NOT NULL,
  location text NOT NULL,
  google_meet_link text NOT NULL,
  calendar_event_id text NOT NULL,
  status text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace.meeting_details (
  position integer NOT NULL,
  meeting_id text PRIMARY KEY,
  reminder_minutes integer NOT NULL,
  calendar_link text NOT NULL,
  invitation_status jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace.activity_log (
  position integer NOT NULL,
  log_id text PRIMARY KEY,
  timestamp text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  old_value text NOT NULL,
  new_value text NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace.notifications (
  position integer NOT NULL,
  notification_id text PRIMARY KEY,
  recipient_id text NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  read_at text NOT NULL,
  created_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace.settings (
  position integer NOT NULL,
  setting_key text PRIMARY KEY,
  value text NOT NULL,
  description text NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace.user_scopes (
  position integer NOT NULL,
  user_id text NOT NULL,
  scope_type text NOT NULL,
  scope_value text NOT NULL,
  PRIMARY KEY (user_id, scope_type, scope_value)
);
CREATE TABLE IF NOT EXISTS workspace.calendar_busy (
  position integer NOT NULL,
  user_id text NOT NULL,
  start_at text NOT NULL,
  end_at text NOT NULL,
  private_label text NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_team_idx ON workspace.tasks (team_id);
CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON workspace.tasks (assigned_to);
CREATE INDEX IF NOT EXISTS invites_email_idx ON workspace.invites (email);
CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON workspace.notifications (recipient_id);
CREATE TABLE IF NOT EXISTS workspace.messages (
  position integer NOT NULL,
  message_id text PRIMARY KEY,
  team_id text NOT NULL,
  author_id text NOT NULL,
  body text NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_team_idx ON workspace.messages (team_id);
ALTER TABLE workspace.messages ADD COLUMN IF NOT EXISTS recipient_id text NOT NULL DEFAULT '';
ALTER TABLE workspace.messages ADD COLUMN IF NOT EXISTS file_name text NOT NULL DEFAULT '';
ALTER TABLE workspace.messages ADD COLUMN IF NOT EXISTS mime_type text NOT NULL DEFAULT '';
ALTER TABLE workspace.messages ADD COLUMN IF NOT EXISTS size_bytes integer NOT NULL DEFAULT 0;
ALTER TABLE workspace.messages ADD COLUMN IF NOT EXISTS storage_ref text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS messages_recipient_idx ON workspace.messages (recipient_id);
CREATE TABLE IF NOT EXISTS workspace.sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL,
  expires_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON workspace.sessions (user_id);
CREATE TABLE IF NOT EXISTS workspace.google_tokens (
  user_id text PRIMARY KEY,
  refresh_token text NOT NULL,
  access_token text NOT NULL,
  expires_at text NOT NULL,
  scopes text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS workspace.meta (
  key text PRIMARY KEY,
  value text NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace.rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL,
  reset_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace.locks (
  name text PRIMARY KEY,
  token text NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE workspace.tasks ADD COLUMN IF NOT EXISTS cc_user_ids text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS workspace.push_subscriptions (
  endpoint text PRIMARY KEY,
  user_id text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON workspace.push_subscriptions (user_id);
`;
var VERSION_KEY = "mops:db-version";
async function ensureWorkspaceSchema(pool) {
  await pool.query(SCHEMA);
}
async function workspaceIsEmpty(pool) {
  const result = await pool.query("SELECT count(*)::text AS count FROM workspace.users");
  return result.rows[0]?.count === "0";
}
function createRedisVersions(redis) {
  return {
    async get() {
      return await redis.get(VERSION_KEY) ?? "0";
    },
    async incr() {
      return String(await redis.incr(VERSION_KEY));
    }
  };
}
function createPgVersions(pool) {
  return {
    async get() {
      const result = await pool.query("SELECT value FROM workspace.meta WHERE key = 'db-version'");
      return result.rows[0]?.value ?? "0";
    },
    async incr() {
      const result = await pool.query(`INSERT INTO workspace.meta (key, value) VALUES ('db-version', '1')
        ON CONFLICT (key) DO UPDATE SET value = (workspace.meta.value::bigint + 1)::text
        RETURNING value`);
      return result.rows[0].value;
    }
  };
}
function createPgSessions(pool) {
  return {
    async get(tokenHash) {
      const result = await pool.query("SELECT user_id, expires_at FROM workspace.sessions WHERE token_hash = $1", [tokenHash]);
      const row = result.rows[0];
      if (!row || row.expires_at <= (/* @__PURE__ */ new Date()).toISOString()) return null;
      return { tokenHash, userId: row.user_id, expiresAt: row.expires_at };
    },
    async put(record) {
      await pool.query(`INSERT INTO workspace.sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)
        ON CONFLICT (token_hash) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at`, [record.tokenHash, record.userId, record.expiresAt]);
    },
    async delete(tokenHash) {
      await pool.query("DELETE FROM workspace.sessions WHERE token_hash = $1", [tokenHash]);
    },
    async listByUser(userId) {
      const now = (/* @__PURE__ */ new Date()).toISOString();
      await pool.query("DELETE FROM workspace.sessions WHERE user_id = $1 AND expires_at <= $2", [userId, now]);
      const result = await pool.query("SELECT token_hash, expires_at FROM workspace.sessions WHERE user_id = $1", [userId]);
      return result.rows.map((row) => ({ tokenHash: row.token_hash, userId, expiresAt: row.expires_at }));
    }
  };
}
function createPgTokens(pool) {
  return {
    async get(userId) {
      const result = await pool.query("SELECT user_id, refresh_token, access_token, expires_at, scopes FROM workspace.google_tokens WHERE user_id = $1", [userId]);
      const row = result.rows[0];
      if (!row) return null;
      return { userId: row.user_id, refreshToken: row.refresh_token, accessToken: row.access_token, expiresAt: row.expires_at, scopes: row.scopes };
    },
    async put(record) {
      await pool.query(`INSERT INTO workspace.google_tokens (user_id, refresh_token, access_token, expires_at, scopes) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id) DO UPDATE SET refresh_token = EXCLUDED.refresh_token, access_token = EXCLUDED.access_token, expires_at = EXCLUDED.expires_at, scopes = EXCLUDED.scopes`, [record.userId, record.refreshToken, record.accessToken, record.expiresAt, record.scopes ?? ""]);
    },
    async delete(userId) {
      await pool.query("DELETE FROM workspace.google_tokens WHERE user_id = $1", [userId]);
    }
  };
}
function createPgLock(pool) {
  return async function lock(fn) {
    const token = randomBytes3(12).toString("hex");
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const acquired = await pool.query(`INSERT INTO workspace.locks (name, token, expires_at) VALUES ('write', $1, now() + interval '15 seconds')
        ON CONFLICT (name) DO UPDATE SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
        WHERE workspace.locks.expires_at <= now()
        RETURNING token`, [token]);
      if (acquired.rows.length > 0) {
        try {
          return await fn();
        } finally {
          await pool.query("DELETE FROM workspace.locks WHERE name = 'write' AND token = $1", [token]);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new HttpError(503, "The workspace is busy. Try again.");
  };
}
function createPgRateLimit(pool) {
  return async (key, bucket) => {
    const limit = bucket === "auth" ? 30 : 240;
    const windowSeconds = bucket === "auth" ? 600 : 60;
    const result = await pool.query(`INSERT INTO workspace.rate_limits (key, count, reset_at) VALUES ($1, 1, now() + ($2 || ' seconds')::interval)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN workspace.rate_limits.reset_at <= now() THEN 1 ELSE workspace.rate_limits.count + 1 END,
        reset_at = CASE WHEN workspace.rate_limits.reset_at <= now() THEN now() + ($2 || ' seconds')::interval ELSE workspace.rate_limits.reset_at END
      RETURNING count`, [`${bucket}:${key}`, String(windowSeconds)]);
    return result.rows[0].count <= limit;
  };
}
function createPostgresStore(pool, versions) {
  let cache = null;
  return {
    kind: "postgres",
    async read() {
      const version = await versions.get();
      if (cache?.version === version) return structuredClone(cache.db);
      const db = await loadWorkspace(pool);
      cache = { version, db: structuredClone(db) };
      return structuredClone(db);
    },
    async write(db) {
      await saveWorkspace(pool, db);
      const version = await versions.incr();
      cache = { version, db: structuredClone(db) };
    }
  };
}
async function loadWorkspace(pool) {
  const [
    users,
    teams,
    members,
    projects,
    invites,
    tasks,
    workflows,
    comments,
    attachments,
    meetings,
    meetingDetails,
    activity,
    notifications,
    settings,
    scopes,
    busy,
    messages
  ] = await Promise.all([
    pool.query("SELECT * FROM workspace.users ORDER BY position"),
    pool.query("SELECT * FROM workspace.teams ORDER BY position"),
    pool.query("SELECT * FROM workspace.team_members ORDER BY position"),
    pool.query("SELECT * FROM workspace.projects ORDER BY position"),
    pool.query("SELECT * FROM workspace.invites ORDER BY position"),
    pool.query("SELECT * FROM workspace.tasks ORDER BY position"),
    pool.query("SELECT * FROM workspace.task_workflows ORDER BY position"),
    pool.query("SELECT * FROM workspace.comments ORDER BY position"),
    pool.query("SELECT * FROM workspace.attachments ORDER BY position"),
    pool.query("SELECT * FROM workspace.meetings ORDER BY position"),
    pool.query("SELECT * FROM workspace.meeting_details ORDER BY position"),
    pool.query("SELECT * FROM workspace.activity_log ORDER BY position"),
    pool.query("SELECT * FROM workspace.notifications ORDER BY position"),
    pool.query("SELECT * FROM workspace.settings ORDER BY position"),
    pool.query("SELECT * FROM workspace.user_scopes ORDER BY position"),
    pool.query("SELECT * FROM workspace.calendar_busy ORDER BY position"),
    pool.query("SELECT * FROM workspace.messages ORDER BY position")
  ]);
  return {
    version: 2,
    users: users.rows.map(userFrom),
    teams: teams.rows.map(teamFrom),
    members: members.rows.map(memberFrom),
    projects: projects.rows.map(projectFrom),
    invites: invites.rows.map(inviteFrom),
    tasks: tasks.rows.map(taskFrom),
    workflows: workflows.rows.map(workflowFrom),
    comments: comments.rows.map(commentFrom),
    attachments: attachments.rows.map(attachmentFrom),
    meetings: meetings.rows.map(meetingFrom),
    meetingDetails: meetingDetails.rows.map(detailFrom),
    activity: activity.rows.map(activityFrom),
    notifications: notifications.rows.map(notificationFrom),
    settings: settings.rows.map(settingFrom),
    scopes: scopes.rows.map(scopeFrom),
    busy: busy.rows.map(busyFrom),
    messages: messages.rows.map(messageFrom)
  };
}
async function saveWorkspace(pool, db) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await insert(client, "users", ["user_id", "name", "email", "department", "role", "reports_to", "status", "access_role"], db.users.map((row) => [row.User_ID, row.Name, row.Email, row.Department, row.Role, row.Reports_To, row.Status, row.Access_Role]));
    await insert(client, "teams", ["team_id", "name", "description", "status", "created_at"], db.teams.map((row) => [row.Team_ID, row.Name, row.Description, row.Status, row.Created_At]));
    await insert(client, "team_members", ["team_id", "user_id", "member_role", "status", "joined_at"], db.members.map((row) => [row.Team_ID, row.User_ID, row.Member_Role, row.Status, row.Joined_At]));
    await insert(client, "projects", ["project_id", "team_id", "name", "key", "next_number", "status"], db.projects.map((row) => [row.Project_ID, row.Team_ID, row.Name, row.Key, row.Next_Number, row.Status]));
    await insert(client, "invites", ["invite_id", "email", "team_id", "access_role", "member_role", "invited_by", "status", "created_at", "responded_at"], db.invites.map((row) => [row.Invite_ID, row.Email, row.Team_ID, row.Access_Role, row.Member_Role, row.Invited_By, row.Status, row.Created_At, row.Responded_At]));
    await insert(client, "tasks", ["task_id", "task_title", "description", "assigned_to", "assigned_by", "priority", "status", "start_date", "due_date", "created_at", "updated_at", "completed_at", "remarks", "project", "department", "type", "team_id", "project_id", "key", "severity", "labels", "cc_user_ids"], db.tasks.map((row) => [row.Task_ID, row.Task_Title, row.Description, row.Assigned_To, row.Assigned_By, row.Priority, row.Status, row.Start_Date, row.Due_Date, row.Created_At, row.Updated_At, row.Completed_At, row.Remarks, row.Project, row.Department, row.Type, row.Team_ID, row.Project_ID, row.Key, row.Severity, row.Labels, row.CC_User_Ids || ""]));
    await insert(client, "task_workflows", ["task_id", "reviewer_id", "blocked_reason", "review_note"], db.workflows.map((row) => [row.Task_ID, row.Reviewer_ID, row.Blocked_Reason, row.Review_Note]));
    await insert(client, "comments", ["comment_id", "task_id", "author_id", "body", "created_at"], db.comments.map((row) => [row.Comment_ID, row.Task_ID, row.Author_ID, row.Body, row.Created_At]));
    await insert(client, "attachments", ["attachment_id", "task_id", "file_name", "mime_type", "size_bytes", "uploaded_by", "uploaded_at", "storage_ref"], db.attachments.map((row) => [row.Attachment_ID, row.Task_ID, row.File_Name, row.Mime_Type, row.Size_Bytes, row.Uploaded_By, row.Uploaded_At, row.Storage_Ref]));
    await insert(client, "meetings", ["meeting_id", "meeting_title", "description", "organized_by", "attendees", "start_datetime", "end_datetime", "location", "google_meet_link", "calendar_event_id", "status", "created_at", "updated_at"], db.meetings.map((row) => [row.Meeting_ID, row.Meeting_Title, row.Description, row.Organized_By, row.Attendees, row.Start_DateTime, row.End_DateTime, row.Location, row.Google_Meet_Link, row.Calendar_Event_ID, row.Status, row.Created_At, row.Updated_At]));
    await insert(client, "meeting_details", ["meeting_id", "reminder_minutes", "calendar_link", "invitation_status"], db.meetingDetails.map((row) => [row.Meeting_ID, row.Reminder_Minutes, row.Calendar_Link, JSON.stringify(row.Invitation_Status)]), /* @__PURE__ */ new Set(["invitation_status"]));
    await insert(client, "activity_log", ["log_id", "timestamp", "actor_id", "action", "entity_type", "entity_id", "old_value", "new_value"], db.activity.map((row) => [row.Log_ID, row.Timestamp, row.Actor_ID, row.Action, row.Entity_Type, row.Entity_ID, row.Old_Value, row.New_Value]));
    await insert(client, "notifications", ["notification_id", "recipient_id", "type", "title", "body", "entity_type", "entity_id", "read_at", "created_at"], db.notifications.map((row) => [row.Notification_ID, row.Recipient_ID, row.Type, row.Title, row.Body, row.Entity_Type, row.Entity_ID, row.Read_At, row.Created_At]));
    await insert(client, "settings", ["setting_key", "value", "description"], db.settings.map((row) => [row.Key, row.Value, row.Description]));
    await insert(client, "user_scopes", ["user_id", "scope_type", "scope_value"], db.scopes.map((row) => [row.User_ID, row.Scope_Type, row.Scope_Value]));
    await insert(client, "calendar_busy", ["user_id", "start_at", "end_at", "private_label"], db.busy.map((row) => [row.User_ID, row.Start, row.End, row.Private_Label]));
    await insert(client, "messages", ["message_id", "team_id", "recipient_id", "author_id", "body", "file_name", "mime_type", "size_bytes", "storage_ref", "created_at"], (db.messages ?? []).map((row) => [row.Message_ID, row.Team_ID, row.Recipient_ID || "", row.Author_ID, row.Body, row.File_Name || "", row.Mime_Type || "", row.Size_Bytes || 0, row.Storage_Ref || "", row.Created_At]));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function insert(client, table, columns, rows, jsonColumns = /* @__PURE__ */ new Set()) {
  await client.query(`DELETE FROM workspace.${table}`);
  for (const [position, row] of rows.entries()) {
    const values = [position, ...row];
    const placeholders = ["$1", ...columns.map((column, index) => jsonColumns.has(column) ? `$${index + 2}::jsonb` : `$${index + 2}`)];
    await client.query(
      `INSERT INTO workspace.${table} (position, ${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
      values
    );
  }
}
function userFrom(row) {
  return { User_ID: row.user_id, Name: row.name, Email: row.email, Department: row.department, Role: row.role, Reports_To: row.reports_to, Status: row.status, Access_Role: row.access_role };
}
function teamFrom(row) {
  return { Team_ID: row.team_id, Name: row.name, Description: row.description, Status: row.status, Created_At: row.created_at };
}
function memberFrom(row) {
  return { Team_ID: row.team_id, User_ID: row.user_id, Member_Role: row.member_role, Status: row.status, Joined_At: row.joined_at };
}
function projectFrom(row) {
  return { Project_ID: row.project_id, Team_ID: row.team_id, Name: row.name, Key: row.key, Next_Number: Number(row.next_number), Status: row.status };
}
function inviteFrom(row) {
  return { Invite_ID: row.invite_id, Email: row.email, Team_ID: row.team_id, Access_Role: row.access_role, Member_Role: row.member_role, Invited_By: row.invited_by, Status: row.status, Created_At: row.created_at, Responded_At: row.responded_at };
}
function taskFrom(row) {
  return { Task_ID: row.task_id, Task_Title: row.task_title, Description: row.description, Assigned_To: row.assigned_to, Assigned_By: row.assigned_by, Priority: row.priority, Status: row.status, Start_Date: row.start_date, Due_Date: row.due_date, Created_At: row.created_at, Updated_At: row.updated_at, Completed_At: row.completed_at, Remarks: row.remarks, Project: row.project, Department: row.department, Type: row.type, Team_ID: row.team_id, Project_ID: row.project_id, Key: row.key, Severity: row.severity, Labels: row.labels, CC_User_Ids: row.cc_user_ids || "" };
}
function workflowFrom(row) {
  return { Task_ID: row.task_id, Reviewer_ID: row.reviewer_id, Blocked_Reason: row.blocked_reason, Review_Note: row.review_note };
}
function commentFrom(row) {
  return { Comment_ID: row.comment_id, Task_ID: row.task_id, Author_ID: row.author_id, Body: row.body, Created_At: row.created_at };
}
function attachmentFrom(row) {
  return { Attachment_ID: row.attachment_id, Task_ID: row.task_id, File_Name: row.file_name, Mime_Type: row.mime_type, Size_Bytes: Number(row.size_bytes), Uploaded_By: row.uploaded_by, Uploaded_At: row.uploaded_at, Storage_Ref: row.storage_ref };
}
function meetingFrom(row) {
  return { Meeting_ID: row.meeting_id, Meeting_Title: row.meeting_title, Description: row.description, Organized_By: row.organized_by, Attendees: row.attendees, Start_DateTime: row.start_datetime, End_DateTime: row.end_datetime, Location: row.location, Google_Meet_Link: row.google_meet_link, Calendar_Event_ID: row.calendar_event_id, Status: row.status, Created_At: row.created_at, Updated_At: row.updated_at };
}
function detailFrom(row) {
  return { Meeting_ID: row.meeting_id, Reminder_Minutes: Number(row.reminder_minutes), Calendar_Link: row.calendar_link, Invitation_Status: row.invitation_status || {} };
}
function activityFrom(row) {
  return { Log_ID: row.log_id, Timestamp: row.timestamp, Actor_ID: row.actor_id, Action: row.action, Entity_Type: row.entity_type, Entity_ID: row.entity_id, Old_Value: row.old_value, New_Value: row.new_value };
}
function notificationFrom(row) {
  return { Notification_ID: row.notification_id, Recipient_ID: row.recipient_id, Type: row.type, Title: row.title, Body: row.body, Entity_Type: row.entity_type, Entity_ID: row.entity_id, Read_At: row.read_at, Created_At: row.created_at };
}
function settingFrom(row) {
  return { Key: row.setting_key, Value: row.value, Description: row.description };
}
function scopeFrom(row) {
  return { User_ID: row.user_id, Scope_Type: row.scope_type, Scope_Value: row.scope_value };
}
function busyFrom(row) {
  return { User_ID: row.user_id, Start: row.start_at, End: row.end_at, Private_Label: row.private_label };
}
function messageFrom(row) {
  return { Message_ID: row.message_id, Team_ID: row.team_id, Recipient_ID: row.recipient_id || "", Author_ID: row.author_id, Body: row.body, File_Name: row.file_name || "", Mime_Type: row.mime_type || "", Size_Bytes: Number(row.size_bytes) || 0, Storage_Ref: row.storage_ref || "", Created_At: row.created_at };
}

// server/redis-store.ts
import { randomBytes as randomBytes4 } from "node:crypto";
var SESSION = "mops:session:";
var USER_SESSIONS = "mops:user-sessions:";
var TOKEN = "mops:google:";
var LOCK = "mops:write-lock";
function createRedisSessions(redis) {
  return {
    async get(tokenHash) {
      const raw = await redis.get(SESSION + tokenHash);
      return raw ? JSON.parse(raw) : null;
    },
    async put(record) {
      const ttl = Math.max(1, Math.ceil((Date.parse(record.expiresAt) - Date.now()) / 1e3));
      await redis.set(SESSION + record.tokenHash, JSON.stringify(record), "EX", ttl);
      await redis.sadd(USER_SESSIONS + record.userId, record.tokenHash);
      await redis.expire(USER_SESSIONS + record.userId, 8 * 24 * 60 * 60);
    },
    async delete(tokenHash) {
      const current = await redis.get(SESSION + tokenHash);
      await redis.del(SESSION + tokenHash);
      if (!current) return;
      const record = JSON.parse(current);
      await redis.srem(USER_SESSIONS + record.userId, tokenHash);
    },
    async listByUser(userId) {
      const hashes = await redis.smembers(USER_SESSIONS + userId);
      const records = [];
      for (const hash of hashes) {
        const raw = await redis.get(SESSION + hash);
        if (!raw) {
          await redis.srem(USER_SESSIONS + userId, hash);
          continue;
        }
        const record = JSON.parse(raw);
        if (record.expiresAt <= (/* @__PURE__ */ new Date()).toISOString()) {
          await redis.del(SESSION + hash);
          await redis.srem(USER_SESSIONS + userId, hash);
          continue;
        }
        records.push(record);
      }
      return records;
    }
  };
}
function createRedisTokens(redis) {
  return {
    async get(userId) {
      const raw = await redis.get(TOKEN + userId);
      return raw ? JSON.parse(raw) : null;
    },
    async put(record) {
      await redis.set(TOKEN + record.userId, JSON.stringify(record));
    },
    async delete(userId) {
      await redis.del(TOKEN + userId);
    }
  };
}
function createRedisLock(redis) {
  return async function lock(fn) {
    const token = randomBytes4(12).toString("hex");
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const acquired = await redis.set(LOCK, token, "PX", 15e3, "NX");
      if (acquired === "OK") {
        try {
          return await fn();
        } finally {
          await redis.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            LOCK,
            token
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new HttpError(503, "The workspace is busy. Try again.");
  };
}
function createRedisRateLimit(redis) {
  return async (key, bucket) => {
    const limit = bucket === "auth" ? 30 : 240;
    const windowSeconds = bucket === "auth" ? 600 : 60;
    const redisKey = `mops:rate:${bucket}:${key}`;
    const count = await redis.incr(redisKey);
    if (count === 1) await redis.expire(redisKey, windowSeconds);
    return count <= limit;
  };
}

// server/store.ts
import fs3 from "node:fs";
import path4 from "node:path";
function readJsonFile(file, fallback) {
  if (!fs3.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs3.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Could not read ${path4.basename(file)}. The file was left unchanged.`);
  }
}

// server/index.ts
var root2 = path5.resolve(path5.dirname(fileURLToPath2(import.meta.url)), "..");
function loadEnvFile() {
  const target = path5.join(root2, ".env");
  if (!fs4.existsSync(target)) return;
  for (const line of fs4.readFileSync(target, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === void 0) process.env[key] = value;
  }
}
function createPool(databaseUrl) {
  const local = /@(localhost|127\.0\.0\.1|postgres)(?::|\/)/.test(databaseUrl);
  if (local || !/[?&]sslmode=/.test(databaseUrl)) return new pg.Pool({ connectionString: databaseUrl });
  const url = new URL(databaseUrl);
  url.searchParams.delete("sslmode");
  return new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });
}
function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("The database name in DATABASE_URL is not supported.");
  return `"${name}"`;
}
async function connectDatabase(databaseUrl) {
  const pool = createPool(databaseUrl);
  try {
    await pool.query("SELECT 1");
    return pool;
  } catch (error) {
    await pool.end().catch(() => void 0);
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    const message = error instanceof Error ? error.message : "";
    if (code !== "3D000" && !/does not exist/i.test(message)) throw error;
    const url = new URL(databaseUrl);
    const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!name || name === "postgres") throw error;
    url.pathname = "/postgres";
    const admin = createPool(url.toString());
    try {
      const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if ((existing.rowCount ?? 0) === 0) {
        await admin.query(`CREATE DATABASE ${quoteIdent(name)}`);
        console.log(`Created database ${name}.`);
      }
    } finally {
      await admin.end();
    }
    const created = createPool(databaseUrl);
    await created.query("SELECT 1");
    return created;
  }
}
async function main() {
  loadEnvFile();
  const config = loadConfig();
  fs4.mkdirSync(config.dataDir, { recursive: true });
  const pool = await connectDatabase(config.databaseUrl);
  await ensureWorkspaceSchema(pool);
  const redis = config.redisUrl ? new Redis(config.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: true }) : null;
  redis?.on("error", () => void 0);
  let redisReady = false;
  if (redis) {
    try {
      await redis.connect();
      await redis.ping();
      redisReady = true;
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      console.error("Redis is not reachable. Sessions will be stored in PostgreSQL. Remove REDIS_URL on Render if you are not using Key Value.");
      redis.disconnect();
    }
  }
  const sessions = redisReady && redis ? createRedisSessions(redis) : createPgSessions(pool);
  const tokens = redisReady && redis ? createRedisTokens(redis) : createPgTokens(pool);
  const versions = redisReady && redis ? createRedisVersions(redis) : createPgVersions(pool);
  const store = createPostgresStore(pool, versions);
  const pushStore = createPushStore(pool);
  if (await workspaceIsEmpty(pool)) {
    const file = path5.join(config.dataDir, "db.json");
    if (fs4.existsSync(file)) {
      const prepared = prepareDatabase(readJsonFile(file, null));
      await store.write(prepared.db);
      console.log("Imported the existing workspace file into PostgreSQL.");
    } else {
      const prepared = prepareDatabase({});
      await store.write(prepared.db);
    }
  }
  if (redisReady && redis && !await redis.get("mops:legacy-imported")) {
    for (const record of readJsonFile(path5.join(config.dataDir, "sessions.json"), [])) {
      if (record.expiresAt > (/* @__PURE__ */ new Date()).toISOString()) await sessions.put(record);
    }
    for (const record of readJsonFile(path5.join(config.dataDir, "google-tokens.json"), [])) {
      await tokens.put(record);
    }
    await redis.set("mops:legacy-imported", "1");
  }
  const app = createApp({
    config,
    store,
    sessions,
    tokens,
    uploadDir: path5.join(config.dataDir, "uploads"),
    versions,
    pushStore,
    lock: redisReady && redis ? createRedisLock(redis) : createPgLock(pool),
    allow: redisReady && redis ? createRedisRateLimit(redis) : createPgRateLimit(pool)
  });
  const server = app.listen(config.port, () => {
    console.log(`Goyal Workspace API on http://localhost:${config.port} (postgres)`);
  });
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 1e4).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
//# sourceMappingURL=index.mjs.map
