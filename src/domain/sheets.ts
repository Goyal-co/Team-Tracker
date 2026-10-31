import type { BusinessDb, InvitationStatus } from "./types";

export const SHEET_NAMES = [
  "USERS",
  "TEAMS",
  "TEAM_MEMBERS",
  "PROJECTS",
  "INVITES",
  "TASKS",
  "MEETINGS",
  "ACTIVITY_LOG",
  "SETTINGS",
  "COMMENTS",
  "ATTACHMENTS",
  "NOTIFICATIONS",
  "TASK_WORKFLOW",
  "USER_SCOPES",
  "MEETING_DETAILS",
  "CALENDAR_BUSY",
] as const;

function objectsFrom(values: string[][]): Record<string, string>[] {
  if (!values.length) return [];
  const headers = values[0].map((header) => String(header).trim());
  return values.slice(1).filter((row) => row.some((cell) => String(cell ?? "").trim() !== "")).map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = String(row[index] ?? "");
    });
    return record;
  });
}

function sheet(headers: string[], rows: readonly object[]): string[][] {
  return [headers, ...rows.map((row) => headers.map((header) => String((row as Record<string, unknown>)[header] ?? "")))];
}

const HEADERS = {
  USERS: ["User_ID", "Name", "Email", "Department", "Role", "Reports_To", "Status", "Access_Role", "Avatar_Ref", "Avatar_Mime"],
  TEAMS: ["Team_ID", "Name", "Description", "Status", "Created_At", "Avatar_Ref", "Avatar_Mime"],
  TEAM_MEMBERS: ["Team_ID", "User_ID", "Member_Role", "Status", "Joined_At"],
  PROJECTS: ["Project_ID", "Team_ID", "Name", "Key", "Next_Number", "Status"],
  INVITES: ["Invite_ID", "Email", "Team_ID", "Access_Role", "Member_Role", "Invited_By", "Status", "Created_At", "Responded_At"],
  TASKS: ["Task_ID", "Task_Title", "Description", "Assigned_To", "Assigned_By", "Priority", "Status", "Start_Date", "Due_Date", "Created_At", "Updated_At", "Completed_At", "Remarks", "Project", "Department", "Type", "Team_ID", "Project_ID", "Key", "Severity", "Labels", "CC_User_Ids"],
  MEETINGS: ["Meeting_ID", "Meeting_Title", "Description", "Organized_By", "Attendees", "Start_DateTime", "End_DateTime", "Location", "Google_Meet_Link", "Calendar_Event_ID", "Status", "Created_At", "Updated_At"],
  ACTIVITY_LOG: ["Log_ID", "Timestamp", "Actor_ID", "Action", "Entity_Type", "Entity_ID", "Old_Value", "New_Value"],
  SETTINGS: ["Key", "Value", "Description"],
  COMMENTS: ["Comment_ID", "Task_ID", "Author_ID", "Body", "Created_At"],
  ATTACHMENTS: ["Attachment_ID", "Task_ID", "File_Name", "Mime_Type", "Size_Bytes", "Uploaded_By", "Uploaded_At", "Storage_Ref"],
  NOTIFICATIONS: ["Notification_ID", "Recipient_ID", "Type", "Title", "Body", "Entity_Type", "Entity_ID", "Read_At", "Created_At"],
  TASK_WORKFLOW: ["Task_ID", "Reviewer_ID", "Blocked_Reason", "Review_Note"],
  USER_SCOPES: ["User_ID", "Scope_Type", "Scope_Value"],
  MEETING_DETAILS: ["Meeting_ID", "Reminder_Minutes", "Calendar_Link", "Invitation_Status"],
  CALENDAR_BUSY: ["User_ID", "Start", "End", "Private_Label"],
} as const;

export function databaseToSheets(db: BusinessDb): Record<string, string[][]> {
  return {
    USERS: sheet([...HEADERS.USERS], db.users),
    TEAMS: sheet([...HEADERS.TEAMS], db.teams),
    TEAM_MEMBERS: sheet([...HEADERS.TEAM_MEMBERS], db.members),
    PROJECTS: sheet([...HEADERS.PROJECTS], db.projects),
    INVITES: sheet([...HEADERS.INVITES], db.invites),
    TASKS: sheet([...HEADERS.TASKS], db.tasks),
    MEETINGS: sheet([...HEADERS.MEETINGS], db.meetings),
    ACTIVITY_LOG: sheet([...HEADERS.ACTIVITY_LOG], db.activity),
    SETTINGS: sheet([...HEADERS.SETTINGS], db.settings),
    COMMENTS: sheet([...HEADERS.COMMENTS], db.comments),
    ATTACHMENTS: sheet([...HEADERS.ATTACHMENTS], db.attachments),
    NOTIFICATIONS: sheet([...HEADERS.NOTIFICATIONS], db.notifications),
    TASK_WORKFLOW: sheet([...HEADERS.TASK_WORKFLOW], db.workflows),
    USER_SCOPES: sheet([...HEADERS.USER_SCOPES], db.scopes),
    MEETING_DETAILS: sheet(
      [...HEADERS.MEETING_DETAILS],
      db.meetingDetails.map((detail) => ({
        Meeting_ID: detail.Meeting_ID,
        Reminder_Minutes: detail.Reminder_Minutes,
        Calendar_Link: detail.Calendar_Link,
        Invitation_Status: JSON.stringify(detail.Invitation_Status),
      })),
    ),
    CALENDAR_BUSY: sheet([...HEADERS.CALENDAR_BUSY], db.busy),
  };
}

function invitation(value: string): Record<string, InvitationStatus> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, InvitationStatus>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function sheetsToDatabase(tables: Record<string, string[][]>): BusinessDb {
  return {
    version: 2,
    users: objectsFrom(tables.USERS ?? []).filter((row) => row.User_ID) as unknown as BusinessDb["users"],
    teams: objectsFrom(tables.TEAMS ?? []).filter((row) => row.Team_ID) as unknown as BusinessDb["teams"],
    members: objectsFrom(tables.TEAM_MEMBERS ?? []).filter((row) => row.Team_ID && row.User_ID) as unknown as BusinessDb["members"],
    projects: objectsFrom(tables.PROJECTS ?? [])
      .filter((row) => row.Project_ID)
      .map((row) => ({ ...row, Next_Number: Number(row.Next_Number || 1) })) as unknown as BusinessDb["projects"],
    invites: objectsFrom(tables.INVITES ?? []).filter((row) => row.Invite_ID) as unknown as BusinessDb["invites"],
    tasks: objectsFrom(tables.TASKS ?? []).filter((row) => row.Task_ID) as unknown as BusinessDb["tasks"],
    meetings: objectsFrom(tables.MEETINGS ?? []).filter((row) => row.Meeting_ID) as unknown as BusinessDb["meetings"],
    activity: objectsFrom(tables.ACTIVITY_LOG ?? []).filter((row) => row.Log_ID) as unknown as BusinessDb["activity"],
    settings: objectsFrom(tables.SETTINGS ?? []).filter((row) => row.Key) as unknown as BusinessDb["settings"],
    comments: objectsFrom(tables.COMMENTS ?? []).filter((row) => row.Comment_ID) as unknown as BusinessDb["comments"],
    messages: [],
    attachments: objectsFrom(tables.ATTACHMENTS ?? [])
      .filter((row) => row.Attachment_ID)
      .map((row) => ({ ...row, Size_Bytes: Number(row.Size_Bytes || 0) })) as unknown as BusinessDb["attachments"],
    notifications: objectsFrom(tables.NOTIFICATIONS ?? []).filter((row) => row.Notification_ID) as unknown as BusinessDb["notifications"],
    workflows: objectsFrom(tables.TASK_WORKFLOW ?? []).filter((row) => row.Task_ID) as unknown as BusinessDb["workflows"],
    scopes: objectsFrom(tables.USER_SCOPES ?? []).filter((row) => row.User_ID && row.Scope_Value) as unknown as BusinessDb["scopes"],
    meetingDetails: objectsFrom(tables.MEETING_DETAILS ?? [])
      .filter((row) => row.Meeting_ID)
      .map((row) => ({
        Meeting_ID: row.Meeting_ID,
        Reminder_Minutes: Number(row.Reminder_Minutes || 30),
        Calendar_Link: row.Calendar_Link || "",
        Invitation_Status: invitation(row.Invitation_Status),
      })),
    busy: objectsFrom(tables.CALENDAR_BUSY ?? []).filter((row) => row.User_ID) as unknown as BusinessDb["busy"],
  };
}

export function emptySheetTables(): Record<string, string[][]> {
  return Object.fromEntries(SHEET_NAMES.map((name) => [name, [] as string[][]]));
}
