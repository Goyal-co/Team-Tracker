import { useMemo, useState } from "react";
import { addDays, formatDay, formatTime, kolkataDayFromIso, kolkataMinutes, kolkataToday, startOfWeek } from "../domain/dates";
import type { Meeting } from "../domain/types";
import { useWorkspace } from "../state";
import { useShell } from "../components/shell";
import { Button, PageHeader } from "../components/ui";

type View = "month" | "week" | "day" | "agenda";

export function CalendarPage() {
  const { data } = useWorkspace();
  const shell = useShell();
  const today = kolkataToday();
  const [cursor, setCursor] = useState(today);
  const [view, setView] = useState<View>(() => (window.matchMedia("(max-width: 767px)").matches ? "agenda" : "week"));
  const names = useMemo(() => new Map(data.users.map((user) => [user.User_ID, user.Name])), [data.users]);
  const meetings = data.meetings.filter((meeting) => meeting.Status === "Scheduled");

  function shift(direction: number) {
    if (view === "month") setCursor(addDays(cursor, direction * 30));
    else if (view === "week") setCursor(addDays(cursor, direction * 7));
    else setCursor(addDays(cursor, direction));
  }

  return (
    <div>
      <PageHeader
        title="Calendar & meetings"
        subtitle="Schedule with the people you can see, then check who is actually free."
        actions={
          <div className="flex w-full flex-col gap-2 sm:w-auto">
            <div className="flex overflow-x-auto rounded-[10px] border border-line bg-white p-0.5">
              {(["month", "week", "day", "agenda"] as View[]).map((item) => (
                <button key={item} type="button" className={`h-8 shrink-0 rounded-lg px-3 text-[13px] capitalize ${view === item ? "bg-accent-soft font-medium text-accent" : "text-muted"}`} onClick={() => setView(item)}>{item}</button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={() => setCursor(today)}>Today</Button>
              <Button type="button" variant="secondary" onClick={() => shift(-1)}>Back</Button>
              <Button type="button" variant="secondary" onClick={() => shift(1)}>Next</Button>
              <Button type="button" onClick={() => shell.openCreateMeeting(cursor)}>+ Schedule</Button>
            </div>
          </div>
        }
      />
      <p className="mb-3 text-[13px] font-medium">{formatDay(cursor)}</p>
      {view === "month" && <MonthGrid cursor={cursor} today={today} meetings={meetings} onOpen={shell.openMeeting} onCreate={shell.openCreateMeeting} />}
      {view === "week" && <WeekGrid cursor={cursor} today={today} meetings={meetings} names={names} onOpen={shell.openMeeting} />}
      {view === "day" && <DayGrid cursor={cursor} meetings={meetings} names={names} onOpen={shell.openMeeting} />}
      {view === "agenda" && <Agenda today={today} meetings={data.meetings} names={names} onOpen={shell.openMeeting} />}
    </div>
  );
}

function meetingsOn(meetings: Meeting[], day: string) {
  return meetings.filter((meeting) => kolkataDayFromIso(meeting.Start_DateTime) === day);
}

function MonthGrid({ cursor, today, meetings, onOpen, onCreate }: { cursor: string; today: string; meetings: Meeting[]; onOpen: (id: string) => void; onCreate: (date?: string) => void }) {
  const start = `${cursor.slice(0, 8)}01`;
  const gridStart = startOfWeek(start);
  const days = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white">
      <div className="grid grid-cols-7 text-[11px] text-muted">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <div key={day} className="px-2 py-2">{day}</div>)}</div>
      <div className="grid grid-cols-7">
        {days.map((day) => (
          <div key={day} className={`min-h-24 border-t border-line p-1 ${day.slice(0, 7) === start.slice(0, 7) ? "" : "bg-slate-50"}`}>
            <button type="button" className={`text-[12px] ${day === today ? "font-semibold text-accent" : ""}`} onClick={() => onCreate(day)}>{Number(day.slice(8))}</button>
            {meetingsOn(meetings, day).slice(0, 3).map((meeting) => (
              <button key={meeting.Meeting_ID} type="button" className="mt-1 block w-full truncate rounded bg-accent-soft px-1 text-left text-[11px] text-accent" onClick={() => onOpen(meeting.Meeting_ID)}>
                {formatTime(meeting.Start_DateTime)} {meeting.Meeting_Title}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function WeekGrid({ cursor, today, meetings, names, onOpen }: { cursor: string; today: string; meetings: Meeting[]; names: Map<string, string>; onOpen: (id: string) => void }) {
  const start = startOfWeek(cursor);
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-white">
      <div className="grid min-w-[840px] grid-cols-[56px_repeat(7,minmax(0,1fr))]">
        <div />
        {days.map((day) => <div key={day} className={`border-b border-l border-line px-2 py-2 text-[12px] ${day === today ? "font-semibold text-accent" : ""}`}>{formatDay(day).replace(/,?\s?\d{4}$/, "")}</div>)}
        <div className="relative">
          {Array.from({ length: 12 }, (_, hour) => <div key={hour} className="h-12 border-t border-line pr-1 text-right text-[10px] text-muted">{hour + 8}:00</div>)}
        </div>
        {days.map((day) => (
          <div key={day} className="relative border-l border-line">
            {Array.from({ length: 12 }, (_, hour) => <div key={hour} className="h-12 border-t border-line" />)}
            {meetingsOn(meetings, day).map((meeting) => {
              const startMin = Math.max(8 * 60, kolkataMinutes(meeting.Start_DateTime));
              const endMin = Math.min(20 * 60, kolkataMinutes(meeting.End_DateTime));
              const top = ((startMin - 8 * 60) / (12 * 60)) * 100;
              const height = Math.max(8, ((endMin - startMin) / (12 * 60)) * 100);
              return (
                <button key={meeting.Meeting_ID} type="button" className="absolute left-1 right-1 overflow-hidden rounded-md bg-accent px-1.5 py-1 text-left text-[11px] text-white" style={{ top: `${top}%`, height: `${height}%` }} onClick={() => onOpen(meeting.Meeting_ID)}>
                  <span className="block truncate font-medium">{meeting.Meeting_Title}</span>
                  <span className="block truncate opacity-80">{names.get(meeting.Organized_By)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function DayGrid({ cursor, meetings, names, onOpen }: { cursor: string; meetings: Meeting[]; names: Map<string, string>; onOpen: (id: string) => void }) {
  const items = meetingsOn(meetings, cursor);
  return (
    <div className="relative h-[672px] overflow-hidden rounded-xl border border-line bg-white">
      {Array.from({ length: 12 }, (_, hour) => (
        <div key={hour} className="flex h-14 border-t border-line">
          <div className="w-16 pr-2 pt-1 text-right text-[11px] text-muted">{hour + 8}:00</div>
          <div className="flex-1" />
        </div>
      ))}
      {items.map((meeting) => {
        const startMin = Math.max(8 * 60, kolkataMinutes(meeting.Start_DateTime));
        const endMin = Math.min(20 * 60, Math.max(startMin + 30, kolkataMinutes(meeting.End_DateTime)));
        const top = ((startMin - 8 * 60) / (12 * 60)) * 100;
        const height = Math.max(6, ((endMin - startMin) / (12 * 60)) * 100);
        return (
          <button key={meeting.Meeting_ID} type="button" className="absolute right-3 overflow-hidden rounded-md bg-accent px-2 py-1 text-left text-[12px] text-white" style={{ left: 72, top: `${top}%`, height: `${height}%` }} onClick={() => onOpen(meeting.Meeting_ID)}>
            {formatTime(meeting.Start_DateTime)} {meeting.Meeting_Title}
            <span className="ml-2 opacity-80">{names.get(meeting.Organized_By)}</span>
          </button>
        );
      })}
    </div>
  );
}

function Agenda({ today, meetings, names, onOpen }: { today: string; meetings: Meeting[]; names: Map<string, string>; onOpen: (id: string) => void }) {
  const upcoming = meetings.filter((meeting) => meeting.Status !== "Cancelled" && kolkataDayFromIso(meeting.Start_DateTime) >= addDays(today, -7)).sort((a, b) => a.Start_DateTime.localeCompare(b.Start_DateTime));
  const groups = new Map<string, Meeting[]>();
  for (const meeting of upcoming) {
    const day = kolkataDayFromIso(meeting.Start_DateTime);
    groups.set(day, [...(groups.get(day) ?? []), meeting]);
  }
  if (groups.size === 0) return <p className="rounded-xl border border-dashed border-line bg-white px-4 py-8 text-center text-[13px] text-muted">No meetings in this range.</p>;
  return (
    <div className="space-y-4">
      {Array.from(groups.entries()).map(([day, items]) => (
        <section key={day}>
          <h2 className="mb-2 text-[13px] font-semibold">{formatDay(day)}</h2>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-white">
            {items.map((meeting) => (
              <li key={meeting.Meeting_ID}>
                <button type="button" className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50" onClick={() => onOpen(meeting.Meeting_ID)}>
                  <span>
                    <span className="block text-[13px] font-medium">{meeting.Meeting_Title}</span>
                    <span className="text-[12px] text-muted">{names.get(meeting.Organized_By)} · {meeting.Attendees.split(",").length} people</span>
                  </span>
                  <span className="text-[13px] text-muted">{formatTime(meeting.Start_DateTime)}–{formatTime(meeting.End_DateTime)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
