import { addDays, formatDay, formatTime, kolkataDayFromIso, kolkataToday } from "../domain/dates";
import { activitySentence, personName } from "../domain/format";
import type { ActivityLog, Meeting, Task, User } from "../domain/types";
import { Avatar } from "./ui";

export function activityKind(action: string): { label: string; dot: string } {
  if (action.startsWith("meeting.")) return { label: "Meeting", dot: "bg-violet-500" };
  if (action.startsWith("task.")) return { label: "Work", dot: "bg-accent" };
  if (action.startsWith("user.")) return { label: "People", dot: "bg-slate-400" };
  return { label: "Group", dot: "bg-emerald-600" };
}

function dayLabel(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  return formatDay(day);
}

export function ActivityFeed({
  items,
  users,
  tasks,
  meetings,
  onOpenTask,
  onOpenMeeting,
}: {
  items: ActivityLog[];
  users: User[];
  tasks: Task[];
  meetings: Meeting[];
  onOpenTask?: (id: string) => void;
  onOpenMeeting?: (id: string) => void;
}) {
  const today = kolkataToday();
  const ordered = [...items].sort((a, b) => b.Timestamp.localeCompare(a.Timestamp));
  const groups: Array<{ day: string; items: ActivityLog[] }> = [];
  for (const item of ordered) {
    const day = kolkataDayFromIso(item.Timestamp);
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }

  if (items.length === 0) {
    return <p className="px-4 py-8 text-center text-[13px] text-muted">No activity yet.</p>;
  }

  return (
    <div>
      {groups.map((group) => (
        <section key={group.day}>
          <h3 className="bg-[#F4F5F7] px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{dayLabel(group.day, today)}</h3>
          <ul className="divide-y divide-line">
            {group.items.map((item) => {
              const actor = personName(users, item.Actor_ID);
              const kind = activityKind(item.Action);
              const sentence = activitySentence(item, users, tasks, meetings);
              const open = item.Entity_Type === "task" ? onOpenTask : item.Entity_Type === "meeting" ? onOpenMeeting : undefined;
              return (
                <li key={item.Log_ID}>
                  <div className="flex items-start gap-3 px-4 py-3">
                    <Avatar name={actor} size={32} />
                    <div className="min-w-0 flex-1">
                      {open ? (
                        <button type="button" className="text-left text-[13px] leading-5 hover:text-accent" onClick={() => open(item.Entity_ID)}>{sentence}</button>
                      ) : (
                        <p className="text-[13px] leading-5">{sentence}</p>
                      )}
                      <p className="mt-1 flex items-center gap-1.5 text-[12px] text-muted">
                        <span className={`h-1.5 w-1.5 rounded-full ${kind.dot}`} />
                        {kind.label}
                      </p>
                    </div>
                    <time className="shrink-0 pt-0.5 text-[12px] text-muted" dateTime={item.Timestamp}>{formatTime(item.Timestamp)}</time>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
