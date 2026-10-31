export const TASK_STATUSES = ["To Do", "In Progress", "Under Review", "Blocked", "Completed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ["Low", "Medium", "High", "Urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ACCESS_ROLES = ["Admin", "Manager", "Coordinator", "Employee"] as const;
export type AccessRole = (typeof ACCESS_ROLES)[number];

export const WORK_TYPES = ["Task", "Bug", "Feature"] as const;
export type WorkType = (typeof WORK_TYPES)[number];

export const SEVERITIES = ["Critical", "High", "Medium", "Low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const MEMBER_ROLES = ["Lead", "Member"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const INVITE_STATUSES = ["Pending", "Accepted", "Declined", "Revoked"] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

export type InvitationStatus = "invited" | "accepted" | "declined" | "tentative" | "needsAction";

export type NotificationType =
  | "task_assigned"
  | "deadline_approaching"
  | "task_overdue"
  | "submitted_for_review"
  | "task_approved"
  | "task_returned"
  | "meeting_invitation"
  | "meeting_rescheduled"
  | "meeting_cancelled"
  | "mentioned"
  | "invited"
  | "direct_message";

export interface User {
  User_ID: string;
  Name: string;
  Email: string;
  Department: string;
  Role: string;
  Reports_To: string;
  Status: "Active" | "Inactive";
  Access_Role: AccessRole;
  Avatar_Ref: string;
  Avatar_Mime: string;
}

export interface Team {
  Team_ID: string;
  Name: string;
  Description: string;
  Status: "Active" | "Archived";
  Created_At: string;
  Avatar_Ref: string;
  Avatar_Mime: string;
}

export interface TeamMember {
  Team_ID: string;
  User_ID: string;
  Member_Role: MemberRole;
  Status: "Active" | "Inactive";
  Joined_At: string;
}

export interface Project {
  Project_ID: string;
  Team_ID: string;
  Name: string;
  Key: string;
  Next_Number: number;
  Status: "Active" | "Archived";
}

export interface Invite {
  Invite_ID: string;
  Email: string;
  Team_ID: string;
  Access_Role: AccessRole;
  Member_Role: MemberRole;
  Invited_By: string;
  Status: InviteStatus;
  Created_At: string;
  Responded_At: string;
}

export interface Task {
  Task_ID: string;
  Task_Title: string;
  Description: string;
  Assigned_To: string;
  Assigned_By: string;
  Priority: Priority;
  Status: TaskStatus;
  Start_Date: string;
  Due_Date: string;
  Created_At: string;
  Updated_At: string;
  Completed_At: string;
  Remarks: string;
  Project: string;
  Department: string;
  Type: WorkType;
  Team_ID: string;
  Project_ID: string;
  Key: string;
  Severity: Severity | "";
  Labels: string;
  CC_User_Ids: string;
}

export interface TaskWorkflow {
  Task_ID: string;
  Reviewer_ID: string;
  Blocked_Reason: string;
  Review_Note: string;
}

export interface WorkspaceMessage {
  Message_ID: string;
  Team_ID: string;
  Recipient_ID: string;
  Author_ID: string;
  Body: string;
  File_Name: string;
  Mime_Type: string;
  Size_Bytes: number;
  Storage_Ref: string;
  Created_At: string;
}

export interface Comment {
  Comment_ID: string;
  Task_ID: string;
  Author_ID: string;
  Body: string;
  Created_At: string;
}

export interface Attachment {
  Attachment_ID: string;
  Task_ID: string;
  File_Name: string;
  Mime_Type: string;
  Size_Bytes: number;
  Uploaded_By: string;
  Uploaded_At: string;
  Storage_Ref: string;
}

export interface Meeting {
  Meeting_ID: string;
  Meeting_Title: string;
  Description: string;
  Organized_By: string;
  Attendees: string;
  Start_DateTime: string;
  End_DateTime: string;
  Location: string;
  Google_Meet_Link: string;
  Calendar_Event_ID: string;
  Status: "Scheduled" | "Cancelled";
  Created_At: string;
  Updated_At: string;
}

export interface MeetingDetail {
  Meeting_ID: string;
  Reminder_Minutes: number;
  Calendar_Link: string;
  Invitation_Status: Record<string, InvitationStatus>;
}

export interface ActivityLog {
  Log_ID: string;
  Timestamp: string;
  Actor_ID: string;
  Action: string;
  Entity_Type: "task" | "meeting" | "user" | "team";
  Entity_ID: string;
  Old_Value: string;
  New_Value: string;
}

export interface Setting {
  Key: string;
  Value: string;
  Description: string;
}

export interface Notification {
  Notification_ID: string;
  Recipient_ID: string;
  Type: NotificationType;
  Title: string;
  Body: string;
  Entity_Type: "task" | "meeting" | "invite" | "user" | "team";
  Entity_ID: string;
  Read_At: string;
  Created_At: string;
}

export interface UserScope {
  User_ID: string;
  Scope_Type: "department" | "user";
  Scope_Value: string;
}

export interface CalendarBusy {
  User_ID: string;
  Start: string;
  End: string;
  Private_Label: string;
}

export interface BusinessDb {
  version: number;
  users: User[];
  teams: Team[];
  members: TeamMember[];
  projects: Project[];
  invites: Invite[];
  tasks: Task[];
  workflows: TaskWorkflow[];
  comments: Comment[];
  messages: WorkspaceMessage[];
  attachments: Attachment[];
  meetings: Meeting[];
  meetingDetails: MeetingDetail[];
  activity: ActivityLog[];
  notifications: Notification[];
  settings: Setting[];
  scopes: UserScope[];
  busy: CalendarBusy[];
}

export interface SystemInfo {
  googleClientId: string;
  calendarOAuthReady: boolean;
  dataStore: "file" | "postgres";
  bootstrapConfigured: boolean;
  pushReady: boolean;
}

export interface Bootstrap extends SystemInfo {
  access: "workspace" | "waiting";
  dbVersion: string;
  me: User;
  users: User[];
  teams: Team[];
  members: TeamMember[];
  projects: Project[];
  invites: Invite[];
  tasks: Task[];
  workflows: TaskWorkflow[];
  comments: Comment[];
  messages: WorkspaceMessage[];
  attachments: Attachment[];
  meetings: Meeting[];
  meetingDetails: MeetingDetail[];
  activity: ActivityLog[];
  notifications: Notification[];
  settings: Setting[];
  scopes: UserScope[];
  calendarConnected: boolean;
}
