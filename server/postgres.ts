import type { Pool, PoolClient } from "pg";
import type { Redis } from "ioredis";
import type {
  ActivityLog,
  Attachment,
  BusinessDb,
  CalendarBusy,
  Comment,
  Invite,
  Meeting,
  MeetingDetail,
  Notification,
  Project,
  Setting,
  Task,
  TaskWorkflow,
  Team,
  TeamMember,
  User,
  UserScope,
  WorkspaceMessage,
} from "../src/domain/types";
import type { DataStore } from "./store";

const SCHEMA = `
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
  labels text NOT NULL
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
`;

const VERSION_KEY = "mops:db-version";

export async function ensureWorkspaceSchema(pool: Pool) {
  await pool.query(SCHEMA);
}

export async function workspaceIsEmpty(pool: Pool) {
  const result = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM workspace.users");
  return result.rows[0]?.count === "0";
}

export function createPostgresStore(pool: Pool, redis: Redis): DataStore {
  let cache: { version: string; db: BusinessDb } | null = null;
  return {
    kind: "postgres",
    async read() {
      const version = (await redis.get(VERSION_KEY)) ?? "0";
      if (cache?.version === version) return structuredClone(cache.db);
      const db = await loadWorkspace(pool);
      cache = { version, db: structuredClone(db) };
      return structuredClone(db);
    },
    async write(db) {
      await saveWorkspace(pool, db);
      const version = String(await redis.incr(VERSION_KEY));
      cache = { version, db: structuredClone(db) };
    },
  };
}

async function loadWorkspace(pool: Pool): Promise<BusinessDb> {
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
    messages,
  ] = await Promise.all([
    pool.query<UserRow>("SELECT * FROM workspace.users ORDER BY position"),
    pool.query<TeamRow>("SELECT * FROM workspace.teams ORDER BY position"),
    pool.query<MemberRow>("SELECT * FROM workspace.team_members ORDER BY position"),
    pool.query<ProjectRow>("SELECT * FROM workspace.projects ORDER BY position"),
    pool.query<InviteRow>("SELECT * FROM workspace.invites ORDER BY position"),
    pool.query<TaskRow>("SELECT * FROM workspace.tasks ORDER BY position"),
    pool.query<WorkflowRow>("SELECT * FROM workspace.task_workflows ORDER BY position"),
    pool.query<CommentRow>("SELECT * FROM workspace.comments ORDER BY position"),
    pool.query<AttachmentRow>("SELECT * FROM workspace.attachments ORDER BY position"),
    pool.query<MeetingRow>("SELECT * FROM workspace.meetings ORDER BY position"),
    pool.query<MeetingDetailRow>("SELECT * FROM workspace.meeting_details ORDER BY position"),
    pool.query<ActivityRow>("SELECT * FROM workspace.activity_log ORDER BY position"),
    pool.query<NotificationRow>("SELECT * FROM workspace.notifications ORDER BY position"),
    pool.query<SettingRow>("SELECT * FROM workspace.settings ORDER BY position"),
    pool.query<ScopeRow>("SELECT * FROM workspace.user_scopes ORDER BY position"),
    pool.query<BusyRow>("SELECT * FROM workspace.calendar_busy ORDER BY position"),
    pool.query<MessageRow>("SELECT * FROM workspace.messages ORDER BY position"),
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
    messages: messages.rows.map(messageFrom),
  };
}

async function saveWorkspace(pool: Pool, db: BusinessDb) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await insert(client, "users", ["user_id", "name", "email", "department", "role", "reports_to", "status", "access_role"], db.users.map((row) => [row.User_ID, row.Name, row.Email, row.Department, row.Role, row.Reports_To, row.Status, row.Access_Role]));
    await insert(client, "teams", ["team_id", "name", "description", "status", "created_at"], db.teams.map((row) => [row.Team_ID, row.Name, row.Description, row.Status, row.Created_At]));
    await insert(client, "team_members", ["team_id", "user_id", "member_role", "status", "joined_at"], db.members.map((row) => [row.Team_ID, row.User_ID, row.Member_Role, row.Status, row.Joined_At]));
    await insert(client, "projects", ["project_id", "team_id", "name", "key", "next_number", "status"], db.projects.map((row) => [row.Project_ID, row.Team_ID, row.Name, row.Key, row.Next_Number, row.Status]));
    await insert(client, "invites", ["invite_id", "email", "team_id", "access_role", "member_role", "invited_by", "status", "created_at", "responded_at"], db.invites.map((row) => [row.Invite_ID, row.Email, row.Team_ID, row.Access_Role, row.Member_Role, row.Invited_By, row.Status, row.Created_At, row.Responded_At]));
    await insert(client, "tasks", ["task_id", "task_title", "description", "assigned_to", "assigned_by", "priority", "status", "start_date", "due_date", "created_at", "updated_at", "completed_at", "remarks", "project", "department", "type", "team_id", "project_id", "key", "severity", "labels"], db.tasks.map((row) => [row.Task_ID, row.Task_Title, row.Description, row.Assigned_To, row.Assigned_By, row.Priority, row.Status, row.Start_Date, row.Due_Date, row.Created_At, row.Updated_At, row.Completed_At, row.Remarks, row.Project, row.Department, row.Type, row.Team_ID, row.Project_ID, row.Key, row.Severity, row.Labels]));
    await insert(client, "task_workflows", ["task_id", "reviewer_id", "blocked_reason", "review_note"], db.workflows.map((row) => [row.Task_ID, row.Reviewer_ID, row.Blocked_Reason, row.Review_Note]));
    await insert(client, "comments", ["comment_id", "task_id", "author_id", "body", "created_at"], db.comments.map((row) => [row.Comment_ID, row.Task_ID, row.Author_ID, row.Body, row.Created_At]));
    await insert(client, "attachments", ["attachment_id", "task_id", "file_name", "mime_type", "size_bytes", "uploaded_by", "uploaded_at", "storage_ref"], db.attachments.map((row) => [row.Attachment_ID, row.Task_ID, row.File_Name, row.Mime_Type, row.Size_Bytes, row.Uploaded_By, row.Uploaded_At, row.Storage_Ref]));
    await insert(client, "meetings", ["meeting_id", "meeting_title", "description", "organized_by", "attendees", "start_datetime", "end_datetime", "location", "google_meet_link", "calendar_event_id", "status", "created_at", "updated_at"], db.meetings.map((row) => [row.Meeting_ID, row.Meeting_Title, row.Description, row.Organized_By, row.Attendees, row.Start_DateTime, row.End_DateTime, row.Location, row.Google_Meet_Link, row.Calendar_Event_ID, row.Status, row.Created_At, row.Updated_At]));
    await insert(client, "meeting_details", ["meeting_id", "reminder_minutes", "calendar_link", "invitation_status"], db.meetingDetails.map((row) => [row.Meeting_ID, row.Reminder_Minutes, row.Calendar_Link, JSON.stringify(row.Invitation_Status)]), new Set(["invitation_status"]));
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

async function insert(client: PoolClient, table: string, columns: string[], rows: unknown[][], jsonColumns = new Set<string>()) {
  await client.query(`DELETE FROM workspace.${table}`);
  for (const [position, row] of rows.entries()) {
    const values = [position, ...row];
    const placeholders = ["$1", ...columns.map((column, index) => (jsonColumns.has(column) ? `$${index + 2}::jsonb` : `$${index + 2}`))];
    await client.query(
      `INSERT INTO workspace.${table} (position, ${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
      values,
    );
  }
}

interface UserRow { user_id: string; name: string; email: string; department: string; role: string; reports_to: string; status: User["Status"]; access_role: User["Access_Role"] }
interface TeamRow { team_id: string; name: string; description: string; status: Team["Status"]; created_at: string }
interface MemberRow { team_id: string; user_id: string; member_role: TeamMember["Member_Role"]; status: TeamMember["Status"]; joined_at: string }
interface ProjectRow { project_id: string; team_id: string; name: string; key: string; next_number: number; status: Project["Status"] }
interface InviteRow { invite_id: string; email: string; team_id: string; access_role: Invite["Access_Role"]; member_role: Invite["Member_Role"]; invited_by: string; status: Invite["Status"]; created_at: string; responded_at: string }
interface TaskRow { task_id: string; task_title: string; description: string; assigned_to: string; assigned_by: string; priority: Task["Priority"]; status: Task["Status"]; start_date: string; due_date: string; created_at: string; updated_at: string; completed_at: string; remarks: string; project: string; department: string; type: Task["Type"]; team_id: string; project_id: string; key: string; severity: Task["Severity"]; labels: string }
interface WorkflowRow { task_id: string; reviewer_id: string; blocked_reason: string; review_note: string }
interface CommentRow { comment_id: string; task_id: string; author_id: string; body: string; created_at: string }
interface AttachmentRow { attachment_id: string; task_id: string; file_name: string; mime_type: string; size_bytes: number; uploaded_by: string; uploaded_at: string; storage_ref: string }
interface MeetingRow { meeting_id: string; meeting_title: string; description: string; organized_by: string; attendees: string; start_datetime: string; end_datetime: string; location: string; google_meet_link: string; calendar_event_id: string; status: Meeting["Status"]; created_at: string; updated_at: string }
interface MeetingDetailRow { meeting_id: string; reminder_minutes: number; calendar_link: string; invitation_status: MeetingDetail["Invitation_Status"] }
interface ActivityRow { log_id: string; timestamp: string; actor_id: string; action: string; entity_type: ActivityLog["Entity_Type"]; entity_id: string; old_value: string; new_value: string }
interface NotificationRow { notification_id: string; recipient_id: string; type: Notification["Type"]; title: string; body: string; entity_type: Notification["Entity_Type"]; entity_id: string; read_at: string; created_at: string }
interface SettingRow { setting_key: string; value: string; description: string }
interface ScopeRow { user_id: string; scope_type: UserScope["Scope_Type"]; scope_value: string }
interface BusyRow { user_id: string; start_at: string; end_at: string; private_label: string }
interface MessageRow { message_id: string; team_id: string; recipient_id: string; author_id: string; body: string; file_name: string; mime_type: string; size_bytes: number; storage_ref: string; created_at: string }

function userFrom(row: UserRow): User { return { User_ID: row.user_id, Name: row.name, Email: row.email, Department: row.department, Role: row.role, Reports_To: row.reports_to, Status: row.status, Access_Role: row.access_role }; }
function teamFrom(row: TeamRow): Team { return { Team_ID: row.team_id, Name: row.name, Description: row.description, Status: row.status, Created_At: row.created_at }; }
function memberFrom(row: MemberRow): TeamMember { return { Team_ID: row.team_id, User_ID: row.user_id, Member_Role: row.member_role, Status: row.status, Joined_At: row.joined_at }; }
function projectFrom(row: ProjectRow): Project { return { Project_ID: row.project_id, Team_ID: row.team_id, Name: row.name, Key: row.key, Next_Number: Number(row.next_number), Status: row.status }; }
function inviteFrom(row: InviteRow): Invite { return { Invite_ID: row.invite_id, Email: row.email, Team_ID: row.team_id, Access_Role: row.access_role, Member_Role: row.member_role, Invited_By: row.invited_by, Status: row.status, Created_At: row.created_at, Responded_At: row.responded_at }; }
function taskFrom(row: TaskRow): Task { return { Task_ID: row.task_id, Task_Title: row.task_title, Description: row.description, Assigned_To: row.assigned_to, Assigned_By: row.assigned_by, Priority: row.priority, Status: row.status, Start_Date: row.start_date, Due_Date: row.due_date, Created_At: row.created_at, Updated_At: row.updated_at, Completed_At: row.completed_at, Remarks: row.remarks, Project: row.project, Department: row.department, Type: row.type, Team_ID: row.team_id, Project_ID: row.project_id, Key: row.key, Severity: row.severity, Labels: row.labels }; }
function workflowFrom(row: WorkflowRow): TaskWorkflow { return { Task_ID: row.task_id, Reviewer_ID: row.reviewer_id, Blocked_Reason: row.blocked_reason, Review_Note: row.review_note }; }
function commentFrom(row: CommentRow): Comment { return { Comment_ID: row.comment_id, Task_ID: row.task_id, Author_ID: row.author_id, Body: row.body, Created_At: row.created_at }; }
function attachmentFrom(row: AttachmentRow): Attachment { return { Attachment_ID: row.attachment_id, Task_ID: row.task_id, File_Name: row.file_name, Mime_Type: row.mime_type, Size_Bytes: Number(row.size_bytes), Uploaded_By: row.uploaded_by, Uploaded_At: row.uploaded_at, Storage_Ref: row.storage_ref }; }
function meetingFrom(row: MeetingRow): Meeting { return { Meeting_ID: row.meeting_id, Meeting_Title: row.meeting_title, Description: row.description, Organized_By: row.organized_by, Attendees: row.attendees, Start_DateTime: row.start_datetime, End_DateTime: row.end_datetime, Location: row.location, Google_Meet_Link: row.google_meet_link, Calendar_Event_ID: row.calendar_event_id, Status: row.status, Created_At: row.created_at, Updated_At: row.updated_at }; }
function detailFrom(row: MeetingDetailRow): MeetingDetail { return { Meeting_ID: row.meeting_id, Reminder_Minutes: Number(row.reminder_minutes), Calendar_Link: row.calendar_link, Invitation_Status: row.invitation_status || {} }; }
function activityFrom(row: ActivityRow): ActivityLog { return { Log_ID: row.log_id, Timestamp: row.timestamp, Actor_ID: row.actor_id, Action: row.action, Entity_Type: row.entity_type, Entity_ID: row.entity_id, Old_Value: row.old_value, New_Value: row.new_value }; }
function notificationFrom(row: NotificationRow): Notification { return { Notification_ID: row.notification_id, Recipient_ID: row.recipient_id, Type: row.type, Title: row.title, Body: row.body, Entity_Type: row.entity_type, Entity_ID: row.entity_id, Read_At: row.read_at, Created_At: row.created_at }; }
function settingFrom(row: SettingRow): Setting { return { Key: row.setting_key, Value: row.value, Description: row.description }; }
function scopeFrom(row: ScopeRow): UserScope { return { User_ID: row.user_id, Scope_Type: row.scope_type, Scope_Value: row.scope_value }; }
function busyFrom(row: BusyRow): CalendarBusy { return { User_ID: row.user_id, Start: row.start_at, End: row.end_at, Private_Label: row.private_label }; }
function messageFrom(row: MessageRow): WorkspaceMessage { return { Message_ID: row.message_id, Team_ID: row.team_id, Recipient_ID: row.recipient_id || "", Author_ID: row.author_id, Body: row.body, File_Name: row.file_name || "", Mime_Type: row.mime_type || "", Size_Bytes: Number(row.size_bytes) || 0, Storage_Ref: row.storage_ref || "", Created_At: row.created_at }; }
