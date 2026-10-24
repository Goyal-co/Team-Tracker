export type ExternalCalendar =
  | { state: "available" }
  | { state: "unknown" }
  | { state: "busy"; windows: Array<{ start: string; end: string }> };

export interface PersonAvailability {
  userId: string;
  state: "available" | "busy" | "unknown";
  windows: Array<{ start: string; end: string; source: "internal" | "google" }>;
}

export function overlaps(startA: string, endA: string, startB: string, endB: string): boolean {
  return startA < endB && startB < endA;
}

function clip(start: string, end: string, rangeStart: string, rangeEnd: string) {
  const clippedStart = start > rangeStart ? start : rangeStart;
  const clippedEnd = end < rangeEnd ? end : rangeEnd;
  if (clippedStart >= clippedEnd) return null;
  return { start: clippedStart, end: clippedEnd };
}

export function mergeAvailability(input: {
  userId: string;
  rangeStart: string;
  rangeEnd: string;
  internal: Array<{ start: string; end: string }>;
  external: ExternalCalendar;
}): PersonAvailability {
  const windows: PersonAvailability["windows"] = [];
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

export interface FreeSlot {
  start: string;
  end: string;
  confirmed: boolean;
}

export function findSlots(input: {
  day: string;
  durationMinutes: number;
  workStart: string;
  workEnd: string;
  workdays: number[];
  busy: Array<{ start: string; end: string }>;
  confirmed: boolean;
  limit?: number;
}): FreeSlot[] {
  const weekday = new Date(`${input.day}T00:00:00Z`).getUTCDay();
  if (!input.workdays.includes(weekday)) return [];
  const [year, month, day] = input.day.split("-").map(Number);
  const [startHour, startMinute] = input.workStart.split(":").map(Number);
  const [endHour, endMinute] = input.workEnd.split(":").map(Number);
  const dayStartUtc = Date.UTC(year, month - 1, day, startHour, startMinute) - (5 * 60 + 30) * 60 * 1000;
  const dayEndUtc = Date.UTC(year, month - 1, day, endHour, endMinute) - (5 * 60 + 30) * 60 * 1000;
  const step = 30 * 60 * 1000;
  const duration = input.durationMinutes * 60 * 1000;
  const slots: FreeSlot[] = [];
  for (let cursor = dayStartUtc; cursor + duration <= dayEndUtc; cursor += step) {
    const start = new Date(cursor).toISOString();
    const end = new Date(cursor + duration).toISOString();
    const blocked = input.busy.some((item) => overlaps(start, end, item.start, item.end));
    if (!blocked) slots.push({ start, end, confirmed: input.confirmed });
    if (slots.length >= (input.limit ?? 6)) break;
  }
  return slots;
}

export function interpretGoogleEntry(entry: { busy?: Array<{ start: string; end: string }>; errors?: unknown[] } | undefined): ExternalCalendar {
  if (!entry || (entry.errors && entry.errors.length > 0)) return { state: "unknown" };
  const windows = (entry.busy ?? [])
    .map((item) => ({ start: new Date(item.start).toISOString(), end: new Date(item.end).toISOString() }))
    .filter((item) => item.start !== "Invalid Date" && !Number.isNaN(new Date(item.start).getTime()));
  if (windows.length) return { state: "busy", windows };
  return { state: "available" };
}
