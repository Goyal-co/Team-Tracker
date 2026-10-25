import { useEffect, useMemo, useState } from "react";
import { durationMinutes, formatDateTime, formatTime, kolkataDayFromIso, kolkataMinutes, kolkataToday } from "../domain/dates";
import { googleTemplateUrl } from "../domain/format";
import { splitIds } from "../domain/ids";
import { meetingAttendeeIds } from "../domain/permissions";
import { useWorkspace } from "../state";
import { useToast } from "../toast";
import { EmployeeMultiSelect } from "./employee-select";
import { Button, Dialog, Drawer, Field, SelectInput, TextArea, TextInput } from "./ui";

function timeValue(iso: string) {
  const minutes = kolkataMinutes(iso);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function MeetingDrawer({
  meetingId,
  presetDate,
  presetAttendeeIds = [],
  onClose,
}: {
  meetingId?: string;
  presetDate?: string;
  presetAttendeeIds?: string[];
  onClose: () => void;
}) {
  const workspace = useWorkspace();
  const { data } = workspace;
  const toast = useToast();
  const meeting = data.meetings.find((item) => item.Meeting_ID === meetingId);
  const detail = data.meetingDetails.find((item) => item.Meeting_ID === meetingId);
  const today = kolkataToday();
  const [title, setTitle] = useState(meeting?.Meeting_Title ?? "");
  const [description, setDescription] = useState(meeting?.Description ?? "");
  const [date, setDate] = useState(meeting ? kolkataDayFromIso(meeting.Start_DateTime) : presetDate || today);
  const [start, setStart] = useState(meeting ? timeValue(meeting.Start_DateTime) : "10:00");
  const [end, setEnd] = useState(meeting ? timeValue(meeting.End_DateTime) : "10:30");
  const [attendees, setAttendees] = useState<string[]>(meeting ? splitIds(meeting.Attendees).filter((id) => id !== meeting.Organized_By) : presetAttendeeIds);
  const [location, setLocation] = useState(meeting?.Location ?? "");
  const [format, setFormat] = useState<"Online" | "In person">(meeting?.Google_Meet_Link ? "Online" : meeting ? "In person" : "Online");
  const [reminder, setReminder] = useState(detail?.Reminder_Minutes ?? 30);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [availability, setAvailability] = useState<Awaited<ReturnType<typeof workspace.availability>> | null>(null);
  const [checking, setChecking] = useState(false);
  const [slots, setSlots] = useState<Awaited<ReturnType<typeof workspace.slots>> | null>(null);
  const people = data.users.filter((user) => user.Status === "Active");
  const names = useMemo(() => new Map(data.users.map((user) => [user.User_ID, user.Name])), [data.users]);
  const duration = useMemo(() => {
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    return Math.max(15, eh * 60 + em - (sh * 60 + sm));
  }, [start, end]);
  const canEdit = !meeting || meeting.Organized_By === data.me.User_ID || data.me.Access_Role === "Admin" || data.me.Access_Role === "Manager";
  const link = detail?.Calendar_Link || (meeting ? googleTemplateUrl(meeting, data.users) : "");
  const invited = Boolean(meeting && meetingAttendeeIds(meeting).includes(data.me.User_ID) && meeting.Organized_By !== data.me.User_ID);
  const myResponse = meeting ? detail?.Invitation_Status[data.me.User_ID] : undefined;
  const localConflicts = useMemo(() => {
    const startIso = new Date(`${date}T${start}:00+05:30`).toISOString();
    const endIso = new Date(`${date}T${end}:00+05:30`).toISOString();
    if (!(startIso < endIso)) return [];
    const ids = new Set([data.me.User_ID, ...attendees]);
    return data.meetings.filter((item) => item.Status === "Scheduled" && item.Meeting_ID !== meeting?.Meeting_ID && item.Start_DateTime < endIso && item.End_DateTime > startIso && meetingAttendeeIds(item).some((id) => ids.has(id)));
  }, [attendees, data.me.User_ID, data.meetings, date, end, meeting?.Meeting_ID, start]);

  useEffect(() => {
    const startIso = new Date(`${date}T${start}:00+05:30`).toISOString();
    const endIso = new Date(`${date}T${end}:00+05:30`).toISOString();
    if (!(startIso < endIso) || meeting?.Status === "Cancelled") return;
    let cancel = false;
    const timer = window.setTimeout(() => {
      setChecking(true);
      void workspace.availability({ attendeeIds: Array.from(new Set([data.me.User_ID, ...attendees])), start: startIso, end: endIso })
        .then((result) => { if (!cancel) setAvailability(result); })
        .catch(() => { if (!cancel) setAvailability(null); })
        .finally(() => { if (!cancel) setChecking(false); });
    }, 400);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
    };
  }, [attendees, data.me.User_ID, date, end, meeting?.Status, start, workspace]);

  function applyDuration(minutes: number) {
    const [hour, minute] = start.split(":").map(Number);
    const total = hour * 60 + minute + minutes;
    setEnd(`${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`);
  }

  async function find() {
    setBusy(true);
    try {
      const result = await workspace.slots({ attendeeIds: Array.from(new Set([data.me.User_ID, ...attendees])), day: date, durationMinutes: duration });
      setSlots(result);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not find a time.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const payload = {
        Meeting_Title: title,
        Description: description,
        Date: date,
        Start_Time: start,
        End_Time: end,
        Attendees: attendees,
        Location: location,
        Format: format,
        Reminder_Minutes: reminder,
        Updated_At: meeting?.Updated_At,
      };
      if (meeting) {
        await workspace.updateMeeting(meeting.Meeting_ID, payload);
        toast("Meeting updated.");
      } else {
        const result = await workspace.createMeeting(payload);
        toast(result.calendarWarning || "Meeting scheduled.");
      }
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save the meeting.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!meeting) return;
    setBusy(true);
    try {
      await workspace.cancelMeeting(meeting.Meeting_ID, meeting.Updated_At);
      toast("Meeting cancelled.");
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not cancel the meeting.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function respond(response: "accepted" | "declined" | "tentative") {
    if (!meeting) return;
    setBusy(true);
    try {
      await workspace.respondMeeting(meeting.Meeting_ID, response);
      toast(response === "declined" ? "You rejected this meeting." : response === "tentative" ? "You asked to postpone." : "You accepted this meeting.");
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not update your response.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function sync() {
    if (!meeting) return;
    setBusy(true);
    try {
      await workspace.syncMeeting(meeting.Meeting_ID);
      toast("Meeting refreshed from Google Calendar.");
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not refresh the meeting.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer title={meeting ? "Meeting" : "Schedule meeting"} subtitle={meeting ? formatDateTime(meeting.Start_DateTime) : "Invitations use each person's Gmail address."} onClose={onClose}>
      <div className="space-y-4 px-5 py-4">
        {meeting?.Status === "Cancelled" && <p className="rounded-lg bg-slate-100 px-3 py-2 text-[13px]">This meeting is cancelled.</p>}
        <Field label="Meeting title">
          <TextInput value={title} disabled={!canEdit || meeting?.Status === "Cancelled"} onChange={(event) => setTitle(event.target.value)} autoFocus />
        </Field>
        <Field label="Description / agenda">
          <TextArea value={description} disabled={!canEdit || meeting?.Status === "Cancelled"} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <TextInput type="date" value={date} disabled={!canEdit || meeting?.Status === "Cancelled"} onChange={(event) => setDate(event.target.value)} />
          </Field>
          <Field label="Duration">
            <SelectInput value={String(duration)} disabled={!canEdit || meeting?.Status === "Cancelled"} onChange={(event) => applyDuration(Number(event.target.value))}>
              {[15, 30, 45, 60, 90, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes} min</option>)}
            </SelectInput>
          </Field>
          <Field label="Start time">
            <TextInput type="time" value={start} disabled={!canEdit || meeting?.Status === "Cancelled"} onChange={(event) => setStart(event.target.value)} />
          </Field>
          <Field label="End time">
            <TextInput type="time" value={end} disabled={!canEdit || meeting?.Status === "Cancelled"} onChange={(event) => setEnd(event.target.value)} />
          </Field>
        </div>
        <Field label="Attendees">
          <EmployeeMultiSelect users={people.filter((user) => user.User_ID !== data.me.User_ID)} value={attendees} onChange={setAttendees} />
        </Field>
        <Field label="How you will meet">
          <SelectInput value={format} disabled={!canEdit || meeting?.Status === "Cancelled"} onChange={(event) => {
            const next = event.target.value as "Online" | "In person";
            setFormat(next);
            if (next === "Online" && reminder === 0) setReminder(10);
          }}>
            <option value="Online">Online — Google Meet, calendar invite, and a reminder to join</option>
            <option value="In person">In person — block the calendar, no Meet link</option>
          </SelectInput>
        </Field>
        <Field label={format === "In person" ? "Place" : "Location note"}>
          <TextInput value={location} placeholder={format === "In person" ? "Room or site" : "Optional"} disabled={!canEdit || meeting?.Status === "Cancelled"} onChange={(event) => setLocation(event.target.value)} />
        </Field>
        {!data.calendarConnected && <p className="text-[12px] text-amber-800">Sign in with Google Calendar access before scheduling. The meeting is saved only after Google accepts it.</p>}
        <Field label="Reminder">
          <SelectInput value={String(reminder)} disabled={!canEdit || meeting?.Status === "Cancelled"} onChange={(event) => setReminder(Number(event.target.value))}>
            {format === "In person" && <option value="0">No extra reminder</option>}
            <option value="10">10 minutes before</option>
            <option value="30">30 minutes</option>
            <option value="60">1 hour</option>
          </SelectInput>
        </Field>
        <div className="rounded-xl border border-line p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold">Conflicts</h3>
            {checking && <span className="text-[12px] text-muted">Checking calendars…</span>}
          </div>
          {availability && <p className="mt-1 text-[12px] text-muted">{availability.live ? "Checked with Google Calendar and meetings already in this workspace." : availability.warning}</p>}
          {!availability && localConflicts.length === 0 && !checking && <p className="mt-2 text-[13px] text-muted">No conflicts for this time.</p>}
          <ul className="mt-2 space-y-1.5">
            {(availability ? availability.people.filter((person) => person.state !== "available") : []).map((person) => (
              <li key={person.userId} className="flex items-start justify-between gap-3 text-[13px]">
                <span>{person.name}</span>
                <span className={person.state === "busy" ? "text-orange-700" : "text-slate-500"}>
                  {person.state === "unknown" ? "Availability unknown" : `Busy · ${person.windows.map((window) => `${formatTime(window.start)}–${formatTime(window.end)}`).join(", ")}`}
                </span>
              </li>
            ))}
            {!availability && localConflicts.map((item) => (
              <li key={item.Meeting_ID} className="text-[13px] text-orange-700">
                {item.Meeting_Title} · {formatTime(item.Start_DateTime)}–{formatTime(item.End_DateTime)} · {meetingAttendeeIds(item).filter((id) => id === data.me.User_ID || attendees.includes(id)).map((id) => names.get(id)).filter(Boolean).join(", ")}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12px] text-muted">You can still schedule. Someone who is busy can postpone or reject the invitation.</p>
          <Button type="button" variant="secondary" className="mt-3" disabled={busy} onClick={() => void find()}>Find a clear time</Button>
        </div>
        {slots && (
          <div className="rounded-xl border border-line p-3">
            <p className="text-[12px] text-muted">{slots.confirmed ? "These times are clear on the connected calendars." : slots.warning || "These times avoid known meetings. External calendars are not fully confirmed."}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {slots.slots.length === 0 && <p className="text-[13px]">No open slot in working hours.</p>}
              {slots.slots.map((slot) => (
                <button
                  key={slot.start}
                  type="button"
                  className="rounded-full border border-line px-2.5 py-1 text-[12px] hover:border-accent"
                  onClick={() => {
                    setStart(timeValue(slot.start));
                    setEnd(timeValue(slot.end));
                  }}
                >
                  {formatTime(slot.start)}–{formatTime(slot.end)}{slot.confirmed ? "" : " · unconfirmed"}
                </button>
              ))}
            </div>
          </div>
        )}
        {meeting && (
          <div>
            <h3 className="mb-2 text-[13px] font-semibold">Invitation status</h3>
            <ul className="space-y-1 text-[13px]">
              {meetingAttendeeIds(meeting).map((id) => (
                <li key={id} className="flex justify-between gap-3">
                  <span>{names.get(id)}</span>
                  <span className="text-muted">{({ invited: "Invited", accepted: "Accepted", declined: "Rejected", tentative: "Wants to postpone", needsAction: "Needs a response" } as const)[detail?.Invitation_Status[id] ?? "invited"]}</span>
                </li>
              ))}
            </ul>
            {meeting.Google_Meet_Link && <a className="mt-3 inline-flex text-[13px] text-accent" href={meeting.Google_Meet_Link} target="_blank" rel="noreferrer">Join meeting</a>}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
          {meeting && link && <a className="mr-auto inline-flex h-9 items-center text-[13px] text-accent" href={link} target="_blank" rel="noreferrer">Open in Google Calendar</a>}
          {meeting?.Calendar_Event_ID && <Button type="button" variant="secondary" disabled={busy} onClick={() => void sync()}>Refresh from Google</Button>}
          {meeting && meeting.Status !== "Cancelled" && canEdit && <Button type="button" variant="danger" disabled={busy} onClick={() => setConfirmCancel(true)}>Cancel meeting</Button>}
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
          {invited && meeting?.Status !== "Cancelled" && (
            <>
              <Button type="button" variant="secondary" disabled={busy || myResponse === "tentative"} onClick={() => void respond("tentative")}>Postpone</Button>
              <Button type="button" variant="danger" disabled={busy || myResponse === "declined"} onClick={() => void respond("declined")}>Reject</Button>
              <Button type="button" variant="secondary" disabled={busy || myResponse === "accepted"} onClick={() => void respond("accepted")}>Accept</Button>
            </>
          )}
          {canEdit && meeting?.Status !== "Cancelled" && <Button type="button" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : meeting ? "Save changes" : "Schedule meeting"}</Button>}
        </div>
        {meeting && <p className="text-[12px] text-muted">Duration {durationMinutes(meeting.Start_DateTime, meeting.End_DateTime)} minutes.</p>}
      </div>
      {confirmCancel && (
        <Dialog
          title="Cancel this meeting?"
          body="Attendees will be notified. If the meeting is on Google Calendar, the event will be cancelled there too."
          confirmLabel="Cancel meeting"
          danger
          onClose={() => setConfirmCancel(false)}
          onConfirm={() => void cancel()}
        />
      )}
    </Drawer>
  );
}
