import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { isPlaceholderEmail } from "../domain/ids";
import { fileMime, fileToBase64, personAvatarSrc } from "../lib";
import { useWorkspace } from "../state";
import { useToast } from "../toast";
import { Avatar, Button, Field, PageHeader, TextInput } from "../components/ui";

export function SettingsPage() {
  const { data, saveSettings, disconnectCalendar, saveProfileName, uploadProfilePhoto, clearProfilePhoto, enablePush, disablePush } = useWorkspace();
  const photoRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const [params] = useSearchParams();
  const start = data.settings.find((item) => item.Key === "workday_start")?.Value ?? "09:30";
  const end = data.settings.find((item) => item.Key === "workday_end")?.Value ?? "18:30";
  const days = (data.settings.find((item) => item.Key === "workdays")?.Value ?? "1,2,3,4,5").split(",").map(Number);
  const [workStart, setWorkStart] = useState(start);
  const [workEnd, setWorkEnd] = useState(end);
  const [workdays, setWorkdays] = useState(days);
  const [profileName, setProfileName] = useState(data.me.Name);
  const [pushOn, setPushOn] = useState(() => window.localStorage.getItem("goyal-push") === "on");
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => {
    setProfileName(data.me.Name);
  }, [data.me.Name]);
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    void navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => {
        const on = Boolean(subscription);
        setPushOn(on);
        window.localStorage.setItem("goyal-push", on ? "on" : "off");
      })
      .catch(() => undefined);
  }, []);
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

  async function onPhoto(file: File | null) {
    if (!file) return;
    try {
      await uploadProfilePhoto({ File_Name: file.name, Mime_Type: fileMime(file), Content_Base64: await fileToBase64(file) });
      toast("Profile photo updated.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not update the photo.", "error");
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
        <p className="mt-1 text-[13px] text-muted">This name and photo are shown on your profile, in chat, and when someone tags you.</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Avatar name={data.me.Name} size={56} src={personAvatarSrc(data.me)} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={() => photoRef.current?.click()}>Change photo</Button>
            {data.me.Avatar_Ref && (
              <Button type="button" variant="ghost" onClick={() => void clearProfilePhoto().then(() => toast("Profile photo removed.")).catch((error: Error) => toast(error.message, "error"))}>Remove</Button>
            )}
            <input
              ref={photoRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(event) => {
                void onPhoto(event.target.files?.[0] ?? null);
                event.target.value = "";
              }}
            />
          </div>
        </div>
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
        <h2 className="text-[14px] font-semibold">Desktop / phone alerts</h2>
        <p className="mt-2 text-[13px] leading-5 text-muted">
          {data.pushReady
            ? "Push alerts appear when this app is in the background. On iPhone, install Goyal Workspace to the Home Screen first."
            : "The server does not have VAPID keys yet. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT, then restart."}
        </p>
        <div className="mt-3 flex gap-2">
          {data.pushReady && !pushOn && (
            <Button
              type="button"
              disabled={pushBusy}
              onClick={() => {
                setPushBusy(true);
                void enablePush()
                  .then((ok) => {
                    setPushOn(ok);
                    toast(ok ? "Push alerts are on." : "Permission was not granted.", ok ? "success" : "error");
                  })
                  .catch((error: Error) => toast(error.message, "error"))
                  .finally(() => setPushBusy(false));
              }}
            >
              Turn on alerts
            </Button>
          )}
          {data.pushReady && pushOn && (
            <Button
              type="button"
              variant="secondary"
              disabled={pushBusy}
              onClick={() => {
                setPushBusy(true);
                void disablePush()
                  .then(() => {
                    setPushOn(false);
                    toast("Push alerts are off.");
                  })
                  .catch((error: Error) => toast(error.message, "error"))
                  .finally(() => setPushBusy(false));
              }}
            >
              Turn off alerts
            </Button>
          )}
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
