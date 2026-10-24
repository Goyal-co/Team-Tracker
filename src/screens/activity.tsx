import { useMemo, useState } from "react";
import { addDays, kolkataDayFromIso, kolkataToday } from "../domain/dates";
import { activitySentence } from "../domain/format";
import { useWorkspace } from "../state";
import { ActivityFeed } from "../components/activity-feed";
import { FilterBar, filterControlClass } from "../components/filters";
import { useShell } from "../components/shell";
import { EmptyState, PageHeader, SelectInput, TextInput } from "../components/ui";

const ACTIONS: Array<[string, string]> = [
  ["task.created", "Work created"],
  ["task.assigned", "Work assigned"],
  ["task.status", "Status changed"],
  ["task.priority", "Priority changed"],
  ["task.deadline", "Deadline changed"],
  ["task.completed", "Work completed"],
  ["task.updated", "Work updated"],
  ["team.created", "Group created"],
  ["team.member_added", "Person added"],
  ["project.created", "Project added"],
  ["invite.sent", "Invite sent"],
  ["invite.accepted", "Invite accepted"],
  ["invite.declined", "Invite declined"],
  ["invite.revoked", "Invite revoked"],
  ["meeting.created", "Meeting scheduled"],
  ["meeting.rescheduled", "Meeting rescheduled"],
  ["meeting.cancelled", "Meeting cancelled"],
  ["user.access", "Access changed"],
  ["user.updated", "Profile updated"],
  ["user.renamed", "Name changed"],
  ["user.created", "First sign-in"],
];

export function ActivityPage() {
  const { data } = useWorkspace();
  const shell = useShell();
  const [employee, setEmployee] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState(addDays(kolkataToday(), -30));
  const [to, setTo] = useState(kolkataToday());
  const [query, setQuery] = useState("");
  const rows = useMemo(() => data.activity.filter((item) => {
    const day = kolkataDayFromIso(item.Timestamp);
    if (from && day < from) return false;
    if (to && day > to) return false;
    if (employee && item.Actor_ID !== employee) return false;
    if (action && item.Action !== action) return false;
    if (query && !activitySentence(item, data.users, data.tasks, data.meetings).toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }), [action, data.activity, data.meetings, data.tasks, data.users, employee, from, query, to]);

  return (
    <div>
      <PageHeader title="Activity" subtitle="What changed across work, groups, meetings, and access." />
      <FilterBar
        active={[employee, action, query, from !== addDays(kolkataToday(), -30) ? from : "", to !== kolkataToday() ? to : ""].filter(Boolean).length}
        onReset={() => { setEmployee(""); setAction(""); setQuery(""); setFrom(addDays(kolkataToday(), -30)); setTo(kolkataToday()); }}
      >
        <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search activity" className={filterControlClass} />
        <SelectInput value={employee} className={filterControlClass} onChange={(event) => setEmployee(event.target.value)}>
          <option value="">All people</option>
          {data.users.map((user) => <option key={user.User_ID} value={user.User_ID}>{user.Name}</option>)}
        </SelectInput>
        <SelectInput value={action} className={filterControlClass} onChange={(event) => setAction(event.target.value)}>
          <option value="">All types</option>
          {ACTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </SelectInput>
        <TextInput type="date" value={from} onChange={(event) => setFrom(event.target.value)} className={filterControlClass} aria-label="From" />
        <TextInput type="date" value={to} onChange={(event) => setTo(event.target.value)} className={filterControlClass} aria-label="To" />
      </FilterBar>
      <p className="mb-2 mt-4 text-[12px] text-muted">{rows.length} {rows.length === 1 ? "event" : "events"}</p>
      {rows.length === 0 ? <EmptyState title="No activity in this range" body="Try a wider date range or clear the filters." /> : (
        <div className="overflow-hidden rounded-xl border border-line bg-white">
          <ActivityFeed
            items={rows}
            users={data.users}
            tasks={data.tasks}
            meetings={data.meetings}
            onOpenTask={shell.openTask}
            onOpenMeeting={shell.openMeeting}
          />
        </div>
      )}
    </div>
  );
}
