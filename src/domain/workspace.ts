import type { BusinessDb, TeamMember, User } from "./types";
import { isPlaceholderEmail } from "./ids";
import { roleRank } from "./permissions";

export function emptyWorkspace(now = new Date()): BusinessDb {
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
      { Key: "created_at", Value: stamp, Description: "When this workspace was created" },
    ],
    scopes: [],
    busy: [],
  };
}

function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

export function prepareDatabase(input: unknown): { db: BusinessDb; persist: boolean } {
  const raw = input && typeof input === "object" ? (input as Partial<BusinessDb>) : {};
  const users = asArray(raw.users);
  if (users.length > 0 && users.every((user) => isPlaceholderEmail(user.Email || ""))) {
    return { db: emptyWorkspace(), persist: true };
  }
  const settings = asArray(raw.settings);
  const persist = raw.version !== 2 || !Array.isArray(raw.teams) || !Array.isArray(raw.invites) || !settings.some((item) => item.Key === "workday_start");
  return { db: normalize(raw), persist };
}

function normalize(raw: Partial<BusinessDb>): BusinessDb {
  const empty = emptyWorkspace();
  const settings = asArray(raw.settings);
  for (const setting of empty.settings) {
    if (!settings.some((item) => item.Key === setting.Key)) settings.push(setting);
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
      CC_User_Ids: task.CC_User_Ids || "",
    })),
    workflows: asArray(raw.workflows),
    comments: asArray(raw.comments),
    messages: asArray(raw.messages).map((message) => ({
      ...message,
      Recipient_ID: message.Recipient_ID || "",
      File_Name: message.File_Name || "",
      Mime_Type: message.Mime_Type || "",
      Size_Bytes: Number(message.Size_Bytes) || 0,
      Storage_Ref: message.Storage_Ref || "",
    })),
    attachments: asArray(raw.attachments),
    meetings: asArray(raw.meetings),
    meetingDetails: asArray(raw.meetingDetails),
    activity: asArray(raw.activity),
    notifications: asArray(raw.notifications),
    settings,
    scopes: asArray(raw.scopes),
    busy: asArray(raw.busy),
  };
}

export function activeMemberships(members: TeamMember[], userId: string): TeamMember[] {
  return members.filter((member) => member.User_ID === userId && member.Status === "Active");
}

export function hasWorkspaceAccess(db: Pick<BusinessDb, "members">, user: User): boolean {
  if (user.Status !== "Active") return false;
  if (user.Access_Role === "Admin") return true;
  return activeMemberships(db.members, user.User_ID).length > 0;
}

export function onTeam(members: TeamMember[], userId: string, teamId: string): boolean {
  return members.some((member) => member.User_ID === userId && member.Team_ID === teamId && member.Status === "Active");
}

export function canInviteToTeam(actor: User, teamId: string, members: TeamMember[]): boolean {
  if (actor.Status !== "Active" || actor.Access_Role === "Employee") return false;
  if (actor.Access_Role === "Admin") return true;
  const membership = members.find((member) => member.User_ID === actor.User_ID && member.Team_ID === teamId && member.Status === "Active");
  if (!membership) return false;
  if (membership.Member_Role === "Lead") return true;
  return actor.Access_Role === "Manager";
}

export function higherRole(current: User["Access_Role"], offered: User["Access_Role"]): User["Access_Role"] {
  return roleRank(offered) < roleRank(current) ? offered : current;
}
