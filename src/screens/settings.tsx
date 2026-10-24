import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { isPlaceholderEmail } from "../domain/ids";
import { useWorkspace } from "../state";
import { useToast } from "../toast";
import { Button, Field, PageHeader, TextInput } from "../components/ui";

export function SettingsPage() {
  const { data, saveSettings, disconnectCalendar, saveProfileName } = useWorkspace();
  const toast = useToast();
  const [params] = useSearchParams();
  const start = data.settings.find((item) => item.Key === "workday_start")?.Value ?? "09:30";
  const end = data.settings.find((item) => item.Key === "workday_end")?.Value ?? "18:30";
  const days = (data.settings.find((item) => item.Key === "workdays")?.Value ?? "1,2,3,4,5").split(",").map(Number);
  const [workStart, setWorkStart] = useState(start);
  const [workEnd, setWorkEnd] = useState(end);
  const [workdays, setWorkdays] = useState(days);
  const [profileName, setProfileName] = useState(data.me.Name);
  useEffect(() => {
    setProfileName(data.me.Name);
  }, [data.me.Name]);
  const admin = data.me.Access_Role === "Admin";
  const calendarNote = params.get("calendar");

  async function saveName() {
    try {
      await saveProfileName(profileName);
      toast("Profile name saved. People can tag this name.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save the profile name.", "error");
    }
  }

  async function saveHours() {
    try {
      await saveSettings({ workday_start: workStart, workday_end: workEnd, workdays });
      toast("Working hours saved.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save settings.", "error");
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Settings" subtitle="Organisation preferences and connections." />
      {calendarNote === "connected" && <p className="mb-3 rounded-xl bg-emerald-50 px-3 py-2 text-[13px] text-emerald-800">Google permissions are accepted.</p>}
      {(calendarNote === "missing" || calendarNote === "missing-refresh" || calendarNote === "failed") && <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-[13px] text-amber-900">Google permissions were not accepted. Use the button below to allow them.</p>}
      <section className="mb-4 rounded-xl border border-line bg-white p-4">
        <h2 className="text-[14px] font-semibold">Profile</h2>
        <p className="mt-1 text-[13px] text-muted">This name is shown on your profile, in the directory, and when someone tags you in a comment.</p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1">
            <Field label="Profile name">
              <TextInput value={profileName} onChange={(event) => setProfileName(event.target.value)} />
            </Field>
          </div>
          <Button type="button" onClick={() => void saveName()}>Save name</Button>
        </div>
        <p className="text-[13px] text-muted">{data.me.Email}</p>
        <p className="text-[13px] text-muted">{data.me.Role || "Employee"} · {data.me.Access_Role}</p>
        {isPlaceholderEmail(data.me.Email) && <p className="mt-2 text-[12px] text-amber-800">This email is a placeholder. An administrator should replace it with your Gmail address before Google invitations will work.</p>}
      </section>
      <section className="mb-4 rounded-xl border border-line bg-white p-4">
        <h2 className="text-[14px] font-semibold">Google Calendar</h2>
        <p className="mt-2 text-[13px] leading-5 text-muted">
          {data.calendarConnected
            ? "Your Google account can create events and check free/busy time for calendars shared with you. Calendars you cannot read stay unknown."
            : data.calendarOAuthReady
              ? "Calendar permission is missing, so meetings cannot create a Meet link or block time. Accept the Google permissions to turn that on."
              : "The server does not have a Google OAuth client yet. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart."}
        </p>
        <p className="mt-2 text-[12px] text-muted">Data store: {data.dataStore === "postgres" ? "PostgreSQL" : "local file"} · Timezone: Asia/Kolkata</p>
        <div className="mt-3 flex gap-2">
          {data.calendarOAuthReady && !data.calendarConnected && <a className="inline-flex h-9 items-center rounded-[10px] bg-accent px-3 text-[13px] font-medium text-white" href="/api/google/calendar/connect">Accept Google permissions</a>}
          {data.calendarConnected && <Button type="button" variant="secondary" onClick={() => void disconnectCalendar().then(() => toast("Google Calendar disconnected.")).catch((error: Error) => toast(error.message, "error"))}>Disconnect</Button>}
        </div>
      </section>
      <section className="mb-4 rounded-xl border border-line bg-white p-4">
        <h2 className="text-[14px] font-semibold">Working hours</h2>
        <p className="mt-1 text-[13px] text-muted">Used when finding a mutually free meeting time.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Starts"><TextInput type="time" value={workStart} disabled={!admin} onChange={(event) => setWorkStart(event.target.value)} /></Field>
          <Field label="Ends"><TextInput type="time" value={workEnd} disabled={!admin} onChange={(event) => setWorkEnd(event.target.value)} /></Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, index) => (
            <label key={label} className="flex items-center gap-1 text-[13px]">
              <input type="checkbox" disabled={!admin} checked={workdays.includes(index)} onChange={(event) => setWorkdays(event.target.checked ? [...workdays, index].sort() : workdays.filter((day) => day !== index))} />
              {label}
            </label>
          ))}
        </div>
        {admin && <Button type="button" className="mt-3" onClick={() => void saveHours()}>Save working hours</Button>}
      </section>
    </div>
  );
}
