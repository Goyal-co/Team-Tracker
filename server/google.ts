import { createSign } from "node:crypto";
import fs from "node:fs";
import type { InvitationStatus } from "../src/domain/types";
import { HttpError } from "./errors";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

let serviceToken: { value: string; expiresAt: number } | null = null;

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

export async function serviceAccountAccessToken(file: string, scope: string): Promise<string> {
  if (serviceToken && serviceToken.expiresAt > Date.now() + 60_000) return serviceToken.value;
  const account = JSON.parse(fs.readFileSync(file, "utf8")) as ServiceAccount;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const assertion = `${unsigned}.${signer.sign(account.private_key).toString("base64url")}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const json = (await response.json()) as { access_token?: string; error_description?: string };
  if (!response.ok || !json.access_token) {
    throw new Error(json.error_description || "Google Sheets authentication failed.");
  }
  serviceToken = { value: json.access_token, expiresAt: Date.now() + 50 * 60 * 1000 };
  return json.access_token;
}

const FULL_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const OWNED_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";
const EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";
const EVENTS_FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.events.freebusy";
const READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export function calendarAuthUrl(config: GoogleConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: `openid email profile ${OWNED_EVENTS_SCOPE} ${FREEBUSY_SCOPE}`,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function tokenRequest(body: URLSearchParams) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error_description?: string;
    error?: string;
  };
  if (!response.ok || !json.access_token) {
    throw new HttpError(502, json.error_description || "Google Calendar authorization failed.");
  }
  return json;
}

export function exchangeAuthCode(config: GoogleConfig, code: string) {
  return tokenRequest(
    new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  );
}

export function refreshAccessToken(config: GoogleConfig, refreshToken: string) {
  return tokenRequest(
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    }),
  );
}

export function calendarScopesGranted(scope: string | undefined) {
  const granted = new Set((scope ?? "").split(/\s+/).filter(Boolean));
  if (granted.has(FULL_CALENDAR_SCOPE)) return true;
  const canWrite = granted.has(EVENTS_SCOPE) || granted.has(OWNED_EVENTS_SCOPE);
  const canReadBusy = granted.has(READONLY_SCOPE) || granted.has(FREEBUSY_SCOPE) || granted.has(EVENTS_FREEBUSY_SCOPE);
  return canWrite && canReadBusy;
}

export async function googleProfile(accessToken: string): Promise<{ email: string; name: string }> {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await response.json()) as { email?: string; name?: string; email_verified?: boolean; error_description?: string };
  if (!response.ok || !json.email || json.email_verified === false) {
    throw new HttpError(401, json.error_description || "Google did not return a verified email.");
  }
  return { email: json.email.toLowerCase(), name: json.name || "" };
}

export async function verifyGoogleIdToken(idToken: string, clientId: string): Promise<{ email: string; name: string }> {
  const url = new URL("https://oauth2.googleapis.com/tokeninfo");
  url.searchParams.set("id_token", idToken);
  const response = await fetch(url);
  const json = (await response.json()) as {
    aud?: string;
    email?: string;
    email_verified?: string | boolean;
    name?: string;
    error_description?: string;
  };
  if (!response.ok || !json.email) throw new HttpError(401, "Google sign-in could not be verified.");
  if (json.aud !== clientId) throw new HttpError(401, "Google sign-in was issued for a different application.");
  if (json.email_verified !== "true" && json.email_verified !== true) {
    throw new HttpError(401, "That Google account does not have a verified email.");
  }
  return { email: json.email.toLowerCase(), name: json.name || "" };
}

export interface GoogleEventResult {
  eventId: string;
  htmlLink: string;
  meetLink: string;
  responses: Record<string, InvitationStatus>;
}

interface GoogleEvent {
  id?: string;
  htmlLink?: string;
  status?: string;
  location?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  attendees?: Array<{ email?: string; responseStatus?: string }>;
  error?: { message?: string };
}

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
}

async function googleJson<T>(response: Response): Promise<T> {
  const json = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!response.ok) throw new HttpError(502, json.error?.message || "Google Calendar request failed.");
  return json;
}

function responsesOf(event: GoogleEvent): Record<string, InvitationStatus> {
  const allowed = new Set(["accepted", "declined", "tentative", "needsAction"]);
  const responses: Record<string, InvitationStatus> = {};
  for (const attendee of event.attendees ?? []) {
    if (!attendee.email) continue;
    const status = attendee.responseStatus && allowed.has(attendee.responseStatus) ? attendee.responseStatus : "needsAction";
    responses[attendee.email.toLowerCase()] = status === "needsAction" ? "invited" : (status as InvitationStatus);
  }
  return responses;
}

function reminderBody(minutes: number, online: boolean) {
  const at = minutes > 0 ? minutes : 10;
  const overrides = online
    ? [
        { method: "email", minutes: at },
        { method: "popup", minutes: at },
      ]
    : [{ method: "popup", minutes: at }];
  return { useDefault: false, overrides };
}

function eventBody(
  input: {
    title: string;
    description: string;
    location: string;
    start: string;
    end: string;
    emails: string[];
    meet: boolean;
    reminderMinutes: number;
  },
  conference: "create" | "remove" | "keep",
) {
  const body: Record<string, unknown> = {
    summary: input.title,
    description: input.description,
    location: input.meet ? input.location || "Google Meet" : input.location,
    start: { dateTime: input.start, timeZone: "Asia/Kolkata" },
    end: { dateTime: input.end, timeZone: "Asia/Kolkata" },
    attendees: input.emails.map((email) => ({ email })),
    transparency: "opaque",
    reminders: reminderBody(input.reminderMinutes, input.meet),
  };
  if (conference === "create") {
    body.conferenceData = {
      createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } },
    };
  }
  if (conference === "remove") body.conferenceData = null;
  return body;
}

function eventResult(event: GoogleEvent): GoogleEventResult {
  const meet = event.conferenceData?.entryPoints?.find((point) => point.entryPointType === "video")?.uri || event.hangoutLink || "";
  return {
    eventId: event.id || "",
    htmlLink: event.htmlLink || "",
    meetLink: meet,
    responses: responsesOf(event),
  };
}

export async function queryFreeBusy(accessToken: string, timeMin: string, timeMax: string, emails: string[]) {
  const response = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify({ timeMin, timeMax, items: emails.map((id) => ({ id })) }),
  });
  const json = await googleJson<{ calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }> }>(response);
  return json.calendars ?? {};
}

export async function createCalendarEvent(
  accessToken: string,
  input: {
    title: string;
    description: string;
    location: string;
    start: string;
    end: string;
    emails: string[];
    meet: boolean;
    reminderMinutes: number;
  },
): Promise<GoogleEventResult> {
  const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all", {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify(eventBody(input, input.meet ? "create" : "keep")),
  });
  const created = eventResult(await googleJson<GoogleEvent>(response));
  if (input.meet && !created.meetLink) throw new HttpError(502, "Google Calendar did not return a Meet link.");
  if (!input.meet) created.meetLink = "";
  return created;
}

export async function updateCalendarEvent(
  accessToken: string,
  eventId: string,
  input: {
    title: string;
    description: string;
    location: string;
    start: string;
    end: string;
    emails: string[];
    meet: boolean;
    reminderMinutes: number;
    hadMeetLink: boolean;
  },
): Promise<GoogleEventResult> {
  const conference = input.meet ? (input.hadMeetLink ? "keep" : "create") : "remove";
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=all`,
    {
      method: "PATCH",
      headers: authHeaders(accessToken),
      body: JSON.stringify(eventBody(input, conference)),
    },
  );
  const updated = eventResult(await googleJson<GoogleEvent>(response));
  if (input.meet && !updated.meetLink) throw new HttpError(502, "Google Calendar did not return a Meet link.");
  if (!input.meet) updated.meetLink = "";
  return updated;
}

export async function deleteCalendarEvent(accessToken: string, eventId: string) {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
    { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (response.status === 404 || response.status === 410) return;
  if (!response.ok) {
    const json = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new HttpError(502, json.error?.message || "Google Calendar could not cancel the event.");
  }
}

export async function getCalendarEvent(accessToken: string, eventId: string): Promise<GoogleEventResult & { status: string; start: string; end: string; location: string }> {
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 404 || response.status === 410) {
    throw new HttpError(404, "This event is no longer on Google Calendar.");
  }
  const event = await googleJson<GoogleEvent>(response);
  return {
    ...eventResult(event),
    status: event.status || "confirmed",
    start: event.start?.dateTime || "",
    end: event.end?.dateTime || "",
    location: event.location || "",
  };
}
