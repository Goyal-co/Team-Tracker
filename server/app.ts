import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { kolkataToIso } from "../src/domain/dates";
import { interpretGoogleEntry } from "../src/domain/availability";
import { zodMessage, addMemberSchema, attachmentSchema, bulkSchema, commentSchema, createTaskSchema, inviteSchema, meetingSchema, profileNameSchema, projectSchema, respondInviteSchema, settingsSchema, teamSchema, workspaceMessageSchema, directMessageSchema, transitionSchema, updateTaskSchema, userSchema } from "../src/domain/schemas";
import type { BusinessDb, User } from "../src/domain/types";
import { hasWorkspaceAccess } from "../src/domain/workspace";
import {
  addAttachment,
  addComment,
  availabilityFor,
  bulkUpdate,
  cancelMeeting,
  canManageMeeting,
  addTeamMember,
  createInvite,
  createMeeting,
  createProject,
  createTask,
  createTeam,
  postDirectMessage,
  postWorkspaceMessage,
  ensureAccount,
  ensureDerivedNotifications,
  markNotifications,
  placeholderAttendees,
  renameSelf,
  respondInvite,
  revokeInvite,
  saveUser,
  slotsFor,
  syncMeeting,
  transitionTask,
  updateMeeting,
  updateSettings,
  updateTask,
  visibleData,
} from "./actions";
import type { AppConfig } from "./config";
import { systemInfo } from "./config";
import { HttpError } from "./errors";
import { deleteStored, readStored, storeBytes } from "./storage";
import {
  calendarAuthUrl,
  calendarScopesGranted,
  createCalendarEvent,
  deleteCalendarEvent,
  exchangeAuthCode,
  getCalendarEvent,
  googleProfile,
  queryFreeBusy,
  refreshAccessToken,
  updateCalendarEvent,
  verifyGoogleIdToken,
} from "./google";
import type { DataStore, SessionRecord, TokenRecord } from "./store";
import type { SessionStore, TokenStore } from "./redis-store";
import { createRateLimiter, csvCell, fileSignatureMatches, securityHeaders } from "./security";

interface AuthedRequest extends Request {
  user?: User;
}

const ALLOWED_FILES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function signState(secret: string, userId: string, nonce: string) {
  const body = `${userId}.${Date.now() + 10 * 60 * 1000}.${nonce}`;
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyState(secret: string, state: string) {
  const parts = state.split(".");
  const sig = parts.pop() ?? "";
  const body = parts.join(".");
  const [userId, exp, nonce] = body.split(".");
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right) || Number(exp) < Date.now() || !userId || !nonce) {
    throw new HttpError(400, "The Google sign-in expired. Try again.");
  }
  return { userId, nonce };
}

function readCookie(header: string | undefined, name: string) {
  if (!header) return "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

export interface AppDeps {
  config: AppConfig;
  store: DataStore;
  sessions: SessionStore;
  tokens: TokenStore;
  uploadDir: string;
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
  allow?: (key: string, bucket: "auth" | "api") => Promise<boolean> | boolean;
}

export function createApp(deps: AppDeps) {
  const { config, store, sessions, tokens, uploadDir } = deps;
  fs.mkdirSync(uploadDir, { recursive: true });

  async function storedFile(input: { File_Name: string; Mime_Type: string; Content_Base64: string }, folder: string) {
    if (!input.Content_Base64) return undefined;
    if (!ALLOWED_FILES.has(input.Mime_Type)) throw new HttpError(400, "This file type is not allowed.");
    const buffer = Buffer.from(input.Content_Base64, "base64");
    if (!buffer.length || buffer.length > 4_000_000) throw new HttpError(400, "Attachments must be under 4 MB.");
    if (!fileSignatureMatches(buffer, input.Mime_Type)) throw new HttpError(400, "The file contents do not match the declared type.");
    const storage = await storeBytes(folder, input.File_Name, buffer, input.Mime_Type, uploadDir);
    return { File_Name: input.File_Name, Mime_Type: input.Mime_Type, Size_Bytes: buffer.length, Storage_Ref: storage };
  }

  function sendDownload(res: Response, name: string, mime: string, bytes: Buffer) {
    const safe = (name || "file").replace(/[^\w.\- ()]+/g, "_");
    res.setHeader("Content-Type", ALLOWED_FILES.has(mime) ? mime : "application/octet-stream");
    res.setHeader("Content-Disposition", `${mime.startsWith("image/") ? "inline" : "attachment"}; filename="${safe}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.send(bytes);
  }
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy ? 1 : false);
  app.use(express.json({ limit: "8mb" }));
  app.use(securityHeaders(config.cookieSecure));
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  const limitAuth = createRateLimiter(30, 10 * 60 * 1000);
  const limitApi = createRateLimiter(240, 60 * 1000);

  let chain: Promise<unknown> = Promise.resolve();
  function localLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  const locked = deps.lock ?? localLock;
  function mutate<T>(fn: (db: BusinessDb) => Promise<{ db: BusinessDb; result: T }> | { db: BusinessDb; result: T }) {
    return locked(async () => {
      const db = await store.read();
      const outcome = await fn(db);
      await store.write(outcome.db);
      return outcome.result;
    });
  }
  function readDb<T>(fn: (db: BusinessDb) => Promise<T> | T) {
    return locked(async () => fn(await store.read()));
  }

  function cookieSuffix() {
    return config.cookieSecure ? "; Secure" : "";
  }

  async function setSession(res: Response, userId: string) {
    const token = randomBytes(32).toString("base64url");
    const mine = (await sessions.listByUser(userId)).filter((item) => item.expiresAt > new Date().toISOString());
    const expiring = mine.slice(0, Math.max(0, mine.length - 7));
    for (const old of expiring) await sessions.delete(old.tokenHash);
    const record: SessionRecord = {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    };
    await sessions.put(record);
    res.append("Set-Cookie", `mops_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${cookieSuffix()}`);
  }

  async function clearSession(res: Response, token: string) {
    if (token) await sessions.delete(hashToken(token));
    res.append("Set-Cookie", `mops_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${cookieSuffix()}`);
  }

  function setOauthNonce(res: Response, nonce: string) {
    res.append("Set-Cookie", `mops_oauth=${encodeURIComponent(nonce)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${cookieSuffix()}`);
  }

  function clearOauthNonce(res: Response) {
    res.append("Set-Cookie", `mops_oauth=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${cookieSuffix()}`);
  }

  async function accessTokenFor(userId: string) {
    const record = await tokens.get(userId);
    if (!record?.refreshToken || !config.googleClientSecret) return null;
    if (record.scopes && !calendarScopesGranted(record.scopes)) return null;
    if (record.accessToken && record.expiresAt > new Date(Date.now() + 60_000).toISOString()) return record.accessToken;
    const refreshed = await refreshAccessToken(
      { clientId: config.googleClientId, clientSecret: config.googleClientSecret, redirectUri: config.googleRedirectUri },
      record.refreshToken,
    );
    record.accessToken = refreshed.access_token || "";
    record.expiresAt = new Date(Date.now() + (refreshed.expires_in ?? 3600) * 1000).toISOString();
    await tokens.put(record);
    return record.accessToken;
  }

  app.use("/api", async (req: AuthedRequest, res, next) => {
    try {
      if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method) && req.get("x-requested-with") !== "fetch") {
        res.status(403).json({ error: "Forbidden." });
        return;
      }
      const token = readCookie(req.headers.cookie, "mops_session");
      if (token) {
        const session = await sessions.get(hashToken(token));
        if (session && session.expiresAt > new Date().toISOString()) {
          const db = await store.read();
          const user = db.users.find((item) => item.User_ID === session.userId && item.Status === "Active");
          if (user) req.user = user;
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  });

  app.use("/api", async (req: AuthedRequest, res, next) => {
    try {
      const full = req.originalUrl.split("?")[0];
      if (full === "/api/health") {
        next();
        return;
      }
      const key = req.user ? `user:${req.user.User_ID}` : `ip:${req.ip || req.socket.remoteAddress || "unknown"}`;
      const authRoute = full.startsWith("/api/auth") || full.startsWith("/api/google");
      const bucket = authRoute ? "auth" : "api";
      const allowed = deps.allow ? await deps.allow(key, bucket) : (authRoute ? limitAuth(key) : limitApi(key));
      if (!allowed) {
        res.setHeader("Retry-After", "60");
        res.status(429).json({ error: "Too many requests. Wait a minute and try again." });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  });

  const route = (fn: (req: AuthedRequest, res: Response) => Promise<unknown>) => (req: AuthedRequest, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
  const authed = (fn: (req: AuthedRequest & { user: User }, res: Response) => Promise<unknown>) =>
    route(async (req, res) => {
      if (!req.user) throw new HttpError(401, "Sign in required.");
      const openWhileWaiting = req.path === "/api/bootstrap" || req.path === "/api/me" || /\/api\/invites\/[^/]+\/respond$/.test(req.path);
      if (!openWhileWaiting) {
        const allowed = await readDb((db) => hasWorkspaceAccess(db, req.user as User));
        if (!allowed) throw new HttpError(403, "Accept an invite before opening the workspace.");
      }
      return fn(req as AuthedRequest & { user: User }, res);
    });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/api/system", (_req, res) => {
    res.json(systemInfo(config, store.kind));
  });
  app.post(
    "/api/auth/google",
    route(async (req, res) => {
      if (!config.googleClientId) throw new HttpError(503, "Google Sign-In is not configured.");
      const credential = String(req.body?.credential || "");
      const identity = await verifyGoogleIdToken(credential, config.googleClientId);
      const user = await mutate((db) => ({ db, result: ensureAccount(db, identity, config.bootstrapAdminEmail) }));
      await setSession(res, user.User_ID);
      res.json({ user });
    }),
  );
  app.post(
    "/api/auth/logout",
    route(async (req, res) => {
      await clearSession(res, readCookie(req.headers.cookie, "mops_session"));
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/bootstrap",
    authed(async (req, res) => {
      const result = await mutate(async (db) => {
        ensureDerivedNotifications(db, req.user.User_ID);
        const google = await tokens.get(req.user.User_ID);
        return {
          db,
          result: {
            ...visibleData(db, req.user),
            ...systemInfo(config, store.kind),
            me: req.user,
            calendarConnected: Boolean(google?.refreshToken && (!google.scopes || calendarScopesGranted(google.scopes))),
          },
        };
      });
      res.json(result);
    }),
  );

  app.post(
    "/api/tasks",
    authed(async (req, res) => {
      const input = createTaskSchema.parse(req.body);
      const task = await mutate((db) => ({ db, result: createTask(db, req.user, input) }));
      res.status(201).json({ task });
    }),
  );
  app.post(
    "/api/tasks/bulk",
    authed(async (req, res) => {
      const input = bulkSchema.parse(req.body);
      if (!input.Priority && !input.to) throw new HttpError(400, "Choose a priority or a status.");
      const tasks = await mutate((db) => ({ db, result: bulkUpdate(db, req.user, input.ids, input) }));
      res.json({ tasks });
    }),
  );
  app.patch(
    "/api/tasks/:id",
    authed(async (req, res) => {
      const input = updateTaskSchema.parse(req.body);
      const task = await mutate((db) => ({ db, result: updateTask(db, req.user, req.params.id, input) }));
      res.json({ task });
    }),
  );
  app.post(
    "/api/tasks/:id/transition",
    authed(async (req, res) => {
      const input = transitionSchema.parse(req.body);
      const task = await mutate((db) => ({ db, result: transitionTask(db, req.user, req.params.id, input.to, input.reason, input.Updated_At) }));
      res.json({ task });
    }),
  );
  app.post(
    "/api/tasks/:id/comments",
    authed(async (req, res) => {
      const input = commentSchema.parse(req.body);
      const comment = await mutate((db) => ({ db, result: addComment(db, req.user, req.params.id, input.Body) }));
      res.status(201).json({ comment });
    }),
  );
  app.post(
    "/api/tasks/:id/attachments",
    authed(async (req, res) => {
      const input = attachmentSchema.parse(req.body);
      const file = await storedFile(input, "tasks");
      if (!file) throw new HttpError(400, "Choose a file.");
      try {
        const attachment = await mutate((db) => {
          const saved = addAttachment(db, req.user, req.params.id, { name: file.File_Name, mime: file.Mime_Type, size: file.Size_Bytes, storage: file.Storage_Ref });
          return { db, result: saved };
        });
        res.status(201).json({ attachment });
      } catch (error) {
        await deleteStored(file.Storage_Ref, uploadDir);
        throw error;
      }
    }),
  );
  app.get(
    "/api/attachments/:id",
    authed(async (req, res) => {
      const file = await readDb((db) => {
        const attachment = db.attachments.find((item) => item.Attachment_ID === req.params.id);
        if (!attachment) throw new HttpError(404, "Attachment not found.");
        const task = db.tasks.find((item) => item.Task_ID === attachment.Task_ID);
        if (!task || !visibleData(db, req.user).tasks.some((item) => item.Task_ID === task.Task_ID)) {
          throw new HttpError(403, "You cannot download this file.");
        }
        return attachment;
      });
      const bytes = await readStored(file.Storage_Ref, uploadDir);
      if (!bytes) throw new HttpError(404, "The file is no longer available.");
      sendDownload(res, file.File_Name, file.Mime_Type, bytes);
    }),
  );

  async function googleForMeeting(actor: User, organizerId: string) {
    return (await accessTokenFor(organizerId)) || (organizerId !== actor.User_ID ? accessTokenFor(actor.User_ID) : null);
  }

  app.post(
    "/api/meetings",
    authed(async (req, res) => {
      const input = meetingSchema.parse(req.body);
      const prepared = await readDb((db) => {
        if (!hasWorkspaceAccess(db, req.user)) throw new HttpError(403, "Accept an invite before opening the workspace.");
        const ids = Array.from(new Set([req.user.User_ID, ...input.Attendees]));
        const placeholders = placeholderAttendees(db, ids);
        if (placeholders.length) throw new HttpError(400, `Replace placeholder emails before scheduling: ${placeholders.join(", ")}.`);
        for (const id of ids) {
          const person = db.users.find((user) => user.User_ID === id);
          if (!person || person.Status !== "Active") throw new HttpError(400, "Every attendee must be an active person in the workspace.");
        }
        return { emails: ids.map((id) => db.users.find((user) => user.User_ID === id)?.Email || "").filter(Boolean) };
      });
      const token = await accessTokenFor(req.user.User_ID);
      if (!token) throw new HttpError(409, "Sign in with Google Calendar access before scheduling. The meeting is not saved until Google accepts it.");
      const online = input.Format === "Online";
      const google = await createCalendarEvent(token, {
        title: input.Meeting_Title,
        description: input.Description,
        location: input.Location,
        start: kolkataToIso(input.Date, input.Start_Time),
        end: kolkataToIso(input.Date, input.End_Time),
        emails: prepared.emails,
        meet: online,
        reminderMinutes: input.Reminder_Minutes,
      });
      try {
        const meeting = await mutate((db) => ({ db, result: createMeeting(db, req.user, input, google) }));
        const calendarWarning = online
          ? "Google Meet link created. Everyone was added to the calendar and will get a reminder to join."
          : "The time is blocked on the calendar. No Meet link was created.";
        res.status(201).json({ meeting, calendarWarning });
      } catch (error) {
        if (google.eventId) await deleteCalendarEvent(token, google.eventId).catch(() => undefined);
        throw error;
      }
    }),
  );
  app.patch(
    "/api/meetings/:id",
    authed(async (req, res) => {
      const input = meetingSchema.parse(req.body);
      if (!input.Updated_At) throw new HttpError(400, "Refresh the meeting and try again.");
      const prepared = await readDb((db) => {
        const current = db.meetings.find((item) => item.Meeting_ID === req.params.id);
        if (!current) throw new HttpError(404, "Meeting not found.");
        if (!canManageMeeting(req.user, current, db)) throw new HttpError(403, "You cannot change this meeting.");
        if (current.Updated_At !== input.Updated_At) throw new HttpError(409, "This was updated by someone else. Refresh and try again.");
        const ids = Array.from(new Set([current.Organized_By, ...input.Attendees]));
        return {
          organizerId: current.Organized_By,
          eventId: current.Calendar_Event_ID,
          hadMeetLink: Boolean(current.Google_Meet_Link),
          emails: ids.map((id) => db.users.find((user) => user.User_ID === id)?.Email || "").filter(Boolean),
        };
      });
      const token = await googleForMeeting(req.user, prepared.organizerId);
      if (!token) throw new HttpError(409, "Connect Google Calendar before changing this meeting.");
      const online = input.Format === "Online";
      const eventInput = {
        title: input.Meeting_Title,
        description: input.Description,
        location: input.Location,
        start: kolkataToIso(input.Date, input.Start_Time),
        end: kolkataToIso(input.Date, input.End_Time),
        emails: prepared.emails,
        meet: online,
        reminderMinutes: input.Reminder_Minutes,
      };
      const google = prepared.eventId
        ? await updateCalendarEvent(token, prepared.eventId, { ...eventInput, hadMeetLink: prepared.hadMeetLink })
        : await createCalendarEvent(token, eventInput);
      const meeting = await mutate((db) => ({ db, result: updateMeeting(db, req.user, req.params.id, { ...input, Updated_At: input.Updated_At || "" }, google) }));
      res.json({ meeting });
    }),
  );
  app.post(
    "/api/meetings/:id/cancel",
    authed(async (req, res) => {
      const expected = String(req.body?.Updated_At || "");
      const prepared = await readDb((db) => {
        const current = db.meetings.find((item) => item.Meeting_ID === req.params.id);
        if (!current) throw new HttpError(404, "Meeting not found.");
        if (!canManageMeeting(req.user, current, db)) throw new HttpError(403, "You cannot change this meeting.");
        return { organizerId: current.Organized_By, eventId: current.Status === "Cancelled" ? "" : current.Calendar_Event_ID };
      });
      if (prepared.eventId) {
        const token = await googleForMeeting(req.user, prepared.organizerId);
        if (!token) throw new HttpError(409, "Connect Google Calendar before cancelling a meeting that is already on Google Calendar.");
        await deleteCalendarEvent(token, prepared.eventId);
      }
      const meeting = await mutate((db) => ({ db, result: cancelMeeting(db, req.user, req.params.id, expected) }));
      res.json({ meeting });
    }),
  );
  app.post(
    "/api/meetings/:id/sync",
    authed(async (req, res) => {
      const prepared = await readDb((db) => {
        const current = db.meetings.find((item) => item.Meeting_ID === req.params.id);
        if (!current?.Calendar_Event_ID) throw new HttpError(400, "This meeting is not linked to Google Calendar yet.");
        if (!canManageMeeting(req.user, current, db)) throw new HttpError(403, "You cannot change this meeting.");
        return { organizerId: current.Organized_By, eventId: current.Calendar_Event_ID };
      });
      const token = await googleForMeeting(req.user, prepared.organizerId);
      if (!token) throw new HttpError(409, "Connect Google Calendar to refresh this meeting.");
      const google = await getCalendarEvent(token, prepared.eventId);
      const meeting = await mutate((db) => ({ db, result: syncMeeting(db, req.user, req.params.id, google) }));
      res.json({ meeting });
    }),
  );

  app.post(
    "/api/calendar/availability",
    authed(async (req, res) => {
      const attendeeIds = Array.isArray(req.body?.attendeeIds) ? req.body.attendeeIds.map(String) : [];
      const start = String(req.body?.start || "");
      const end = String(req.body?.end || "");
      if (!attendeeIds.length || !start || !end || start >= end) throw new HttpError(400, "Choose attendees and a valid time.");
      const snapshot = await readDb((db) => ({
        db,
        emails: attendeeIds.map((id: string) => db.users.find((user) => user.User_ID === id)?.Email.toLowerCase() || "").filter(Boolean),
      }));
      const external: Record<string, ReturnType<typeof interpretGoogleEntry>> = {};
      let warning = "";
      const token = await accessTokenFor(req.user.User_ID);
      if (!token) {
        warning = "Google Calendar is not connected. People are marked unknown unless they already have a meeting in this workspace.";
      } else {
        try {
          const calendars = await queryFreeBusy(token, new Date(start).toISOString(), new Date(end).toISOString(), snapshot.emails);
          for (const email of snapshot.emails) external[email] = interpretGoogleEntry(calendars[email]);
        } catch (error) {
          warning = error instanceof Error ? error.message : "Google Calendar could not be checked.";
        }
      }
      res.json({
        people: availabilityFor(snapshot.db, attendeeIds, new Date(start).toISOString(), new Date(end).toISOString(), external),
        warning,
        live: Boolean(token) && !warning,
      });
    }),
  );
  app.post(
    "/api/calendar/slots",
    authed(async (req, res) => {
      const attendeeIds = Array.isArray(req.body?.attendeeIds) ? req.body.attendeeIds.map(String) : [];
      const day = String(req.body?.day || "");
      const durationMinutes = Number(req.body?.durationMinutes || 30);
      if (!attendeeIds.length || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, "Choose attendees and a date.");
      const snapshot = await readDb((db) => ({
        db,
        emails: attendeeIds.map((id: string) => db.users.find((user) => user.User_ID === id)?.Email.toLowerCase() || "").filter(Boolean),
      }));
      const externalBusy: Array<{ start: string; end: string }> = [];
      let confirmed = true;
      let warning = "";
      const token = await accessTokenFor(req.user.User_ID);
      const rangeStart = kolkataToIso(day, "00:00");
      const rangeEnd = kolkataToIso(day, "23:59");
      if (!token) {
        confirmed = false;
        warning = "Suggestions avoid meetings already in this workspace. External calendars are not connected, so these times are not confirmed.";
      } else {
        try {
          const calendars = await queryFreeBusy(token, rangeStart, rangeEnd, snapshot.emails);
          for (const email of snapshot.emails) {
            const entry = interpretGoogleEntry(calendars[email]);
            if (entry.state === "unknown") confirmed = false;
            if (entry.state === "busy") externalBusy.push(...entry.windows);
          }
        } catch (error) {
          confirmed = false;
          warning = error instanceof Error ? error.message : "Google Calendar could not be checked.";
        }
      }
      res.json({ slots: slotsFor(snapshot.db, attendeeIds, day, durationMinutes, externalBusy, confirmed), warning, confirmed });
    }),
  );

  app.get(
    "/api/export/work",
    authed(async (req, res) => {
      const csv = await readDb((db) => {
        const visible = visibleData(db, req.user);
        const names = new Map(db.users.map((user) => [user.User_ID, user.Name]));
        const teams = new Map(db.teams.map((team) => [team.Team_ID, team.Name]));
        const header = ["Key", "Type", "Title", "Status", "Priority", "Severity", "Team", "Project", "Assignee", "Due", "Labels"];
        const lines = [header.join(",")];
        for (const task of visible.tasks) {
          lines.push([
            task.Key,
            task.Type,
            task.Task_Title,
            task.Status,
            task.Priority,
            task.Severity,
            teams.get(task.Team_ID) || "",
            task.Project,
            names.get(task.Assigned_To) || "",
            task.Due_Date,
            task.Labels,
          ].map(csvCell).join(","));
        }
        return lines.join("\r\n");
      });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=\"goyal-work.csv\"");
      res.send(csv);
    }),
  );

  app.patch(
    "/api/me",
    authed(async (req, res) => {
      const input = profileNameSchema.parse(req.body);
      const user = await mutate((db) => ({ db, result: renameSelf(db, req.user, input.Name) }));
      res.json({ user });
    }),
  );
  app.post(
    "/api/teams",
    authed(async (req, res) => {
      const input = teamSchema.parse(req.body);
      const team = await mutate((db) => ({ db, result: createTeam(db, req.user, input) }));
      res.status(201).json({ team });
    }),
  );
  app.post(
    "/api/teams/:id/messages",
    authed(async (req, res) => {
      const input = workspaceMessageSchema.parse(req.body);
      const file = await storedFile(input, "chat");
      try {
        const message = await mutate((db) => ({ db, result: postWorkspaceMessage(db, req.user, req.params.id, input.Body, file) }));
        res.status(201).json({ message });
      } catch (error) {
        if (file) await deleteStored(file.Storage_Ref, uploadDir);
        throw error;
      }
    }),
  );
  app.get(
    "/api/messages",
    authed(async (req, res) => {
      const messages = await readDb((db) => visibleData(db, req.user).messages);
      res.json({ messages });
    }),
  );
  app.post(
    "/api/messages",
    authed(async (req, res) => {
      const input = directMessageSchema.parse(req.body);
      const file = await storedFile(input, "chat");
      try {
        const message = await mutate((db) => ({ db, result: postDirectMessage(db, req.user, input.Recipient_ID, input.Body, file) }));
        res.status(201).json({ message });
      } catch (error) {
        if (file) await deleteStored(file.Storage_Ref, uploadDir);
        throw error;
      }
    }),
  );
  app.get(
    "/api/messages/:id/file",
    authed(async (req, res) => {
      const file = await readDb((db) => {
        const message = visibleData(db, req.user).messages.find((item) => item.Message_ID === req.params.id && item.Storage_Ref);
        if (!message) throw new HttpError(404, "That file was not found.");
        return message;
      });
      const bytes = await readStored(file.Storage_Ref, uploadDir);
      if (!bytes) throw new HttpError(404, "The file is no longer available.");
      sendDownload(res, file.File_Name, file.Mime_Type, bytes);
    }),
  );
  app.post(
    "/api/projects",
    authed(async (req, res) => {
      const input = projectSchema.parse(req.body);
      const project = await mutate((db) => ({ db, result: createProject(db, req.user, input) }));
      res.status(201).json({ project });
    }),
  );
  app.post(
    "/api/teams/:id/members",
    authed(async (req, res) => {
      const input = addMemberSchema.parse(req.body);
      const member = await mutate((db) => ({ db, result: addTeamMember(db, req.user, req.params.id, input.User_ID, input.Member_Role) }));
      res.status(201).json({ member });
    }),
  );
  app.post(
    "/api/invites",
    authed(async (req, res) => {
      const input = inviteSchema.parse(req.body);
      const invite = await mutate((db) => ({ db, result: createInvite(db, req.user, input) }));
      res.status(201).json({ invite });
    }),
  );
  app.post(
    "/api/invites/:id/revoke",
    authed(async (req, res) => {
      const invite = await mutate((db) => ({ db, result: revokeInvite(db, req.user, req.params.id) }));
      res.json({ invite });
    }),
  );
  app.post(
    "/api/invites/:id/respond",
    authed(async (req, res) => {
      const input = respondInviteSchema.parse(req.body);
      const invite = await mutate((db) => ({ db, result: respondInvite(db, req.user, req.params.id, input.accept) }));
      res.json({ invite });
    }),
  );
  app.post(
    "/api/users",
    authed(async (req, res) => {
      const input = userSchema.parse(req.body);
      const user = await mutate((db) => ({ db, result: saveUser(db, req.user, input) }));
      res.status(201).json({ user });
    }),
  );
  app.patch(
    "/api/users/:id",
    authed(async (req, res) => {
      const input = userSchema.parse(req.body);
      const user = await mutate((db) => ({ db, result: saveUser(db, req.user, { ...input, User_ID: req.params.id }) }));
      res.json({ user });
    }),
  );
  app.post(
    "/api/notifications/read",
    authed(async (req, res) => {
      const ids = req.body?.all ? "all" : Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
      await mutate((db) => {
        markNotifications(db, req.user, ids);
        return { db, result: true };
      });
      res.json({ ok: true });
    }),
  );
  app.put(
    "/api/settings",
    authed(async (req, res) => {
      const input = settingsSchema.parse(req.body);
      await mutate((db) => {
        updateSettings(db, req.user, input);
        return { db, result: true };
      });
      res.json({ ok: true });
    }),
  );

  async function rememberGoogleToken(userId: string, exchanged: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }) {
    const previous = await tokens.get(userId);
    const refreshToken = exchanged.refresh_token || previous?.refreshToken;
    if (!refreshToken) return false;
    const record: TokenRecord = {
      userId,
      refreshToken,
      accessToken: exchanged.access_token || "",
      expiresAt: new Date(Date.now() + (exchanged.expires_in ?? 3600) * 1000).toISOString(),
      scopes: exchanged.scope || previous?.scopes || "",
    };
    await tokens.put(record);
    return true;
  }

  app.get(
    "/api/auth/google/start",
    route(async (_req, res) => {
      if (!config.googleClientId || !config.googleClientSecret) throw new HttpError(503, "Google sign-in is not configured.");
      const nonce = randomBytes(16).toString("base64url");
      setOauthNonce(res, nonce);
      res.redirect(calendarAuthUrl(
        { clientId: config.googleClientId, clientSecret: config.googleClientSecret, redirectUri: config.googleRedirectUri },
        signState(config.sessionSecret, "login", nonce),
      ));
    }),
  );
  app.get(
    "/api/google/calendar/connect",
    route(async (req, res) => {
      if (!req.user) {
        res.redirect("/login");
        return;
      }
      if (!config.googleClientId || !config.googleClientSecret) throw new HttpError(503, "Google Calendar is not configured on the server.");
      const nonce = randomBytes(16).toString("base64url");
      setOauthNonce(res, nonce);
      res.redirect(calendarAuthUrl(
        { clientId: config.googleClientId, clientSecret: config.googleClientSecret, redirectUri: config.googleRedirectUri },
        signState(config.sessionSecret, req.user.User_ID, nonce),
      ));
    }),
  );
  app.get(
    "/api/google/calendar/callback",
    route(async (req, res) => {
      let userId = "";
      let nonce = "";
      try {
        const parsed = verifyState(config.sessionSecret, String(req.query.state || ""));
        userId = parsed.userId;
        nonce = parsed.nonce;
      } catch {
        res.redirect("/login?error=calendar");
        return;
      }
      if (readCookie(req.headers.cookie, "mops_oauth") !== nonce) {
        res.redirect("/login?error=calendar");
        return;
      }
      clearOauthNonce(res);
      const exchanged = await exchangeAuthCode(
        { clientId: config.googleClientId, clientSecret: config.googleClientSecret, redirectUri: config.googleRedirectUri },
        String(req.query.code || ""),
      );
      if (userId === "login") {
        if (!exchanged.access_token) {
          res.redirect("/login?error=calendar");
          return;
        }
        const profile = await googleProfile(exchanged.access_token);
        let user: User;
        try {
          user = await mutate((db) => ({ db, result: ensureAccount(db, profile, config.bootstrapAdminEmail) }));
        } catch {
          res.redirect("/login?error=unknown");
          return;
        }
        const saved = await rememberGoogleToken(user.User_ID, exchanged);
        await setSession(res, user.User_ID);
        const access = await readDb((db) => hasWorkspaceAccess(db, user));
        if (!saved || !calendarScopesGranted(exchanged.scope)) {
          res.redirect(access ? "/settings?calendar=missing" : "/");
          return;
        }
        res.redirect("/");
        return;
      }
      if (!req.user || req.user.User_ID !== userId) {
        res.redirect("/login?error=calendar");
        return;
      }
      if (!(await rememberGoogleToken(userId, exchanged)) || !calendarScopesGranted(exchanged.scope)) {
        res.redirect("/settings?calendar=missing");
        return;
      }
      res.redirect("/settings?calendar=connected");
    }),
  );
  app.post(
    "/api/google/calendar/disconnect",
    authed(async (req, res) => {
      await tokens.delete(req.user.User_ID);
      res.json({ ok: true });
    }),
  );

  const dist = path.resolve(uploadDir, "..", "..", "dist");
  if (fs.existsSync(path.join(dist, "index.html"))) {
    app.use(express.static(dist));
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      if (req.path.startsWith("/api")) return next();
      res.sendFile(path.join(dist, "index.html"));
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      res.status(400).json({ error: zodMessage(error) });
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error(error);
    res.status(500).json({ error: "Something went wrong." });
  });

  return app;
}
