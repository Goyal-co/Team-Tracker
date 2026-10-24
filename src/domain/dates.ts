export const TIMEZONE = "Asia/Kolkata";

export function kolkataParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return { year: get("year"), month: get("month"), day: get("day"), hour, minute: get("minute") };
}

export function kolkataToday(now = new Date()): string {
  const parts = kolkataParts(now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function kolkataDayFromIso(iso: string): string {
  return kolkataToday(new Date(iso));
}

export function kolkataMinutes(iso: string): number {
  const parts = kolkataParts(new Date(iso));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

export function addDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function weekdayIndex(ymd: string): number {
  const [year, month, day] = ymd.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function startOfWeek(ymd: string): string {
  const day = weekdayIndex(ymd);
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return addDays(ymd, mondayOffset);
}

export function endOfWeek(ymd: string): string {
  return addDays(startOfWeek(ymd), 6);
}

export function startOfMonth(ymd: string): string {
  return `${ymd.slice(0, 8)}01`;
}

export function endOfMonth(ymd: string): string {
  const [year, month] = ymd.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${ymd.slice(0, 8)}${String(last).padStart(2, "0")}`;
}

export function kolkataToIso(ymd: string, time: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const utc = Date.UTC(year, month - 1, day, hour, minute) - (5 * 60 + 30) * 60 * 1000;
  return new Date(utc).toISOString();
}

export function isOverdue(task: { Status: string; Due_Date: string }, today = kolkataToday()): boolean {
  return task.Status !== "Completed" && Boolean(task.Due_Date) && task.Due_Date < today;
}

export function greeting(now = new Date()): string {
  const hour = Number(kolkataParts(now).hour);
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export function formatDay(ymd: string): string {
  if (!ymd) return "—";
  const [year, month, day] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: TIMEZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

export function formatDateTime(iso: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: TIMEZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatTime(iso: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatLongDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: TIMEZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(now);
}

export function dueLabel(ymd: string, today = kolkataToday()): { text: string; overdue: boolean } {
  if (!ymd) return { text: "No date", overdue: false };
  if (ymd === today) return { text: "Today", overdue: false };
  if (ymd === addDays(today, 1)) return { text: "Tomorrow", overdue: false };
  if (ymd === addDays(today, -1)) return { text: "Yesterday", overdue: true };
  return { text: formatDay(ymd), overdue: ymd < today };
}

export function minutesToTime(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function timeToMinutes(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

export function durationMinutes(startIso: string, endIso: string): number {
  return Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000));
}
