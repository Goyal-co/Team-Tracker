import type { ActivityLog, Meeting, Task, User } from "./types";

export type CommentPart =
  | { kind: "text"; value: string }
  | { kind: "mention"; userId: string; label: string }
  | { kind: "link"; href: string; label: string };

const URL_PATTERN = /\b((?:https?:\/\/|www\.)[^\s<>"'`]+)/gi;

function splitUrls(value: string): CommentPart[] {
  const parts: CommentPart[] = [];
  let cursor = 0;
  for (const match of value.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ kind: "text", value: value.slice(cursor, index) });
    let label = match[1];
    let trailing = "";
    while (label.length > 0 && /[.,;:!?)\]}'"]$/.test(label)) {
      trailing = `${label.slice(-1)}${trailing}`;
      label = label.slice(0, -1);
    }
    if (label) {
      parts.push({ kind: "link", href: label.startsWith("www.") ? `https://${label}` : label, label });
    } else {
      trailing = `${match[1]}${trailing}`;
    }
    if (trailing) parts.push({ kind: "text", value: trailing });
    cursor = index + match[0].length;
  }
  if (cursor < value.length) parts.push({ kind: "text", value: value.slice(cursor) });
  return parts.length ? parts : [{ kind: "text", value }];
}

export function commentParts(body: string, users: User[]): CommentPart[] {
  const parts: CommentPart[] = [];
  const pattern = /@\[([^\]]+)\]\(([^)\s]+)\)/g;
  let cursor = 0;
  for (const match of body.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push(...splitUrls(body.slice(cursor, index)));
    const user = users.find((item) => item.User_ID === match[2]);
    parts.push({ kind: "mention", userId: match[2], label: user?.Name || match[1] });
    cursor = index + match[0].length;
  }
  if (cursor < body.length) parts.push(...splitUrls(body.slice(cursor)));
  return parts;
}

export function mentionIds(body: string): string[] {
  return Array.from(new Set(commentParts(body, []).flatMap((part) => (part.kind === "mention" ? [part.userId] : []))));
}

export function personName(users: User[], id: string): string {
  return users.find((user) => user.User_ID === id)?.Name ?? "Someone";
}

export function firstName(name: string): string {
  return name.split(" ")[0] || name;
}

export function activitySentence(log: ActivityLog, users: User[], tasks: Task[], meetings: Meeting[]): string {
  const actor = firstName(personName(users, log.Actor_ID));
  const task = tasks.find((item) => item.Task_ID === log.Entity_ID);
  const meeting = meetings.find((item) => item.Meeting_ID === log.Entity_ID);
  const taskTitle = task?.Task_Title ?? log.New_Value ?? "a task";
  const meetingTitle = meeting?.Meeting_Title ?? "a meeting";
  switch (log.Action) {
    case "user.renamed":
      return `${log.New_Value} is now the profile name.`;
    case "task.created":
      return `${actor} created ${task ? `${task.Type.toLowerCase()} ${task.Key}` : taskTitle}.`;
    case "team.created":
      return `${actor} created the team ${log.New_Value}.`;
    case "team.member_added":
      return `${actor} added ${log.New_Value} to a group.`;
    case "project.created":
      return `${actor} added the project ${log.New_Value}.`;
    case "invite.sent":
      return `${actor} invited ${log.New_Value} to a team.`;
    case "invite.revoked":
      return `${actor} revoked the invitation for ${log.Old_Value}.`;
    case "invite.accepted":
      return `${actor} joined ${log.New_Value}.`;
    case "invite.declined":
      return `${actor} declined an invitation.`;
    case "user.created":
      return `${log.New_Value} signed in for the first time.`;
    case "task.assigned":
      return `${actor} assigned ${taskTitle} to ${log.New_Value}.`;
    case "task.status":
      if (log.New_Value === "Under Review") return `${actor} submitted ${taskTitle} for review.`;
      if (log.New_Value === "Completed") return `${actor} completed ${taskTitle}.`;
      if (log.New_Value === "Blocked") return `${actor} marked ${taskTitle} as blocked.`;
      return `${actor} moved ${taskTitle} to ${log.New_Value}.`;
    case "task.priority":
      return `${actor} changed the priority of ${taskTitle} to ${log.New_Value}.`;
    case "task.deadline":
      return `${actor} changed the deadline of ${taskTitle} to ${log.New_Value}.`;
    case "task.completed":
      return `${actor} completed ${taskTitle}.`;
    case "task.updated":
      return `${actor} updated ${taskTitle}.`;
    case "meeting.created":
      return `${actor} scheduled ${meetingTitle}.`;
    case "meeting.rescheduled":
      return `${actor} rescheduled ${meetingTitle}.`;
    case "meeting.cancelled":
      return `${actor} cancelled ${meetingTitle}.`;
    case "user.access":
      return `${actor} changed ${personName(users, log.Entity_ID)}'s access from ${log.Old_Value} to ${log.New_Value}.`;
    case "user.updated":
      return `${actor} updated ${personName(users, log.Entity_ID)}.`;
    default:
      return `${actor} recorded ${log.Action.replaceAll(".", " ")}.`;
  }
}

export function googleTemplateUrl(meeting: Meeting, users: User[]): string {
  const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const emails = meeting.Attendees.split(",")
    .map((id) => users.find((user) => user.User_ID === id.trim())?.Email)
    .filter((email): email is string => Boolean(email));
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: meeting.Meeting_Title,
    dates: `${stamp(meeting.Start_DateTime)}/${stamp(meeting.End_DateTime)}`,
    details: meeting.Description,
    location: meeting.Location,
    add: emails.join(","),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
