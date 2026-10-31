import { describe, expect, it } from "vitest";
import { addDays, isOverdue, kolkataMinutes, kolkataToIso, kolkataToday, startOfWeek } from "./dates";
import { findSlots, interpretGoogleEntry, mergeAvailability } from "./availability";
import { commentParts } from "./format";
import { canAssignTo, canEditTaskMetadata, canReview, canViewTask, descendantIds } from "./permissions";
import { transitionAllowed } from "./workflow";
import { databaseToSheets, sheetsToDatabase } from "./sheets";
import { companyFixture } from "./fixture";
import { prepareDatabase } from "./workspace";
import type { Task, User } from "./types";

const NOW = new Date("2026-10-21T06:30:00.000Z");

describe("dates", () => {
  it("converts Kolkata wall time to UTC", () => {
    expect(kolkataToIso("2026-10-21", "10:00")).toBe("2026-10-21T04:30:00.000Z");
    expect(kolkataToday(NOW)).toBe("2026-10-21");
    expect(kolkataMinutes(kolkataToIso("2026-10-21", "10:00"))).toBe(600);
    expect(startOfWeek("2026-10-21")).toBe("2026-10-19");
  });

  it("treats overdue separately from status", () => {
    expect(isOverdue({ Status: "In Progress", Due_Date: "2026-10-20" }, "2026-10-21")).toBe(true);
    expect(isOverdue({ Status: "In Progress", Due_Date: "2026-10-21" }, "2026-10-21")).toBe(false);
    expect(isOverdue({ Status: "Completed", Due_Date: "2026-10-19" }, "2026-10-21")).toBe(false);
  });
});

describe("permissions", () => {
  const db = companyFixture(NOW);
  const user = (id: string) => db.users.find((item) => item.User_ID === id) as User;
  const task = (id: string) => db.tasks.find((item) => item.Task_ID === id) as Task;

  it("lets both reporting managers on the team see the work and hides it from someone outside", () => {
    const bug = task("T-0001");
    expect(canViewTask(user("U-002"), bug, undefined, db.users, db.scopes, db.members)).toBe(true);
    expect(canViewTask(user("U-004"), bug, undefined, db.users, db.scopes, db.members)).toBe(true);
    expect(canViewTask(user("U-005"), bug, undefined, db.users, db.scopes, db.members)).toBe(false);
  });

  it("lets a manager on the team see every task in that workspace", () => {
    const dbLocal = companyFixture(NOW);
    const manager = dbLocal.users.find((item) => item.User_ID === "U-004") as User;
    manager.Access_Role = "Manager";
    const other = { ...task("T-0001"), Assigned_To: "U-002", Assigned_By: "U-003" };
    expect(canViewTask(manager, other, undefined, dbLocal.users, dbLocal.scopes, dbLocal.members)).toBe(true);
  });

  it("lets the creator and a manager on CC approve, but not an employee on CC", () => {
    const dbLocal = companyFixture(NOW);
    const employee = dbLocal.users.find((item) => item.User_ID === "U-003") as User;
    const work = { ...task("T-0001"), Assigned_To: "U-002", Assigned_By: "U-002", CC_User_Ids: "U-003" };
    const withManagerCc = { ...work, Assigned_By: "U-003", CC_User_Ids: "U-004" };
    expect(canReview(user("U-003"), withManagerCc, undefined, dbLocal.users, dbLocal.scopes, dbLocal.members)).toBe(true);
    expect(canReview(user("U-004"), withManagerCc, undefined, dbLocal.users, dbLocal.scopes, dbLocal.members)).toBe(true);
    expect(canReview(employee, work, undefined, dbLocal.users, dbLocal.scopes, dbLocal.members)).toBe(false);
    expect(canViewTask(employee, work, undefined, dbLocal.users, dbLocal.scopes, dbLocal.members)).toBe(true);
  });

  it("stops a reporting cycle", () => {
    const users = [
      { ...user("U-001"), Reports_To: "U-003" },
      user("U-002"),
      user("U-003"),
    ];
    expect(descendantIds(users, "U-001").has("U-003")).toBe(true);
    expect(descendantIds(users, "U-001").size).toBeGreaterThan(0);
  });

  it("lets a group member assign work inside the group and keeps them from editing priority", () => {
    expect(canEditTaskMetadata(user("U-003"), task("T-0001"), db.users, db.scopes, db.members)).toBe(false);
    expect(canAssignTo(user("U-003"), "U-002", db.users, db.scopes, db.members, "TM-001")).toBe(true);
    expect(canAssignTo(user("U-002"), "U-003", db.users, db.scopes, db.members, "TM-001")).toBe(true);
    expect(canAssignTo(user("U-005"), "U-003", db.users, db.scopes, db.members, "TM-001")).toBe(false);
  });
});

describe("workflow", () => {
  const db = companyFixture(NOW);
  const actor = db.users.find((item) => item.User_ID === "U-003") as User;
  const task = db.tasks.find((item) => item.Task_ID === "T-0001") as Task;

  it("requires review before completion", () => {
    expect(transitionAllowed({ actor, task, users: db.users, scopes: db.scopes, members: db.members, to: "Completed" })).toMatch(/Cannot move/);
    expect(transitionAllowed({ actor, task, users: db.users, scopes: db.scopes, members: db.members, to: "Under Review" })).toBeNull();
    expect(transitionAllowed({ actor, task, users: db.users, scopes: db.scopes, members: db.members, to: "Blocked" })).toMatch(/reason/);
  });
});

describe("availability", () => {
  it("does not call an unreadable calendar available", () => {
    const result = mergeAvailability({
      userId: "U-008",
      rangeStart: "2026-10-22T04:30:00.000Z",
      rangeEnd: "2026-10-22T05:00:00.000Z",
      internal: [],
      external: { state: "unknown" },
    });
    expect(result.state).toBe("unknown");
  });

  it("shows a known meeting as busy and proposes the surrounding slots", () => {
    const busy = mergeAvailability({
      userId: "U-008",
      rangeStart: "2026-10-22T05:30:00.000Z",
      rangeEnd: "2026-10-22T06:00:00.000Z",
      internal: [{ start: "2026-10-22T05:30:00.000Z", end: "2026-10-22T06:30:00.000Z" }],
      external: { state: "unknown" },
    });
    expect(busy.state).toBe("busy");
    const slots = findSlots({
      day: "2026-10-22",
      durationMinutes: 30,
      workStart: "09:30",
      workEnd: "18:30",
      workdays: [1, 2, 3, 4, 5],
      busy: [{ start: "2026-10-22T05:30:00.000Z", end: "2026-10-22T06:30:00.000Z" }],
      confirmed: false,
    });
    expect(slots.some((slot) => slot.start === "2026-10-22T05:30:00.000Z")).toBe(false);
    expect(slots[0]?.confirmed).toBe(false);
  });

  it("reads Google free/busy errors as unknown and an empty busy list as available", () => {
    expect(interpretGoogleEntry({ errors: [{}] }).state).toBe("unknown");
    expect(interpretGoogleEntry({ busy: [] }).state).toBe("available");
    expect(interpretGoogleEntry(undefined).state).toBe("unknown");
  });
});

describe("commentParts", () => {
  it("turns pasted URLs into links and keeps mentions", () => {
    const parts = commentParts("See https://docs.google.com/spreadsheets/d/abc123 and @[Ada](U-1).", []);
    expect(parts).toEqual([
      { kind: "text", value: "See " },
      { kind: "link", href: "https://docs.google.com/spreadsheets/d/abc123", label: "https://docs.google.com/spreadsheets/d/abc123" },
      { kind: "text", value: " and " },
      { kind: "mention", userId: "U-1", label: "Ada" },
      { kind: "text", value: "." },
    ]);
  });

  it("prefixes www links and drops trailing punctuation from the href", () => {
    const parts = commentParts("Open www.example.com/path).", []);
    expect(parts).toEqual([
      { kind: "text", value: "Open " },
      { kind: "link", href: "https://www.example.com/path", label: "www.example.com/path" },
      { kind: "text", value: ")." },
    ]);
  });
});

describe("sheets", () => {
  it("round-trips teams, invites, and work", () => {
    const original = companyFixture(NOW);
    const restored = sheetsToDatabase(databaseToSheets(original));
    expect(restored.teams.map((team) => team.Name)).toEqual(original.teams.map((team) => team.Name));
    expect(restored.tasks.map((item) => item.Key)).toEqual(["TECH-1", "MKT-1"]);
    expect(restored.projects.find((project) => project.Key === "TECH")?.Next_Number).toBe(3);
    expect(restored.settings.find((item) => item.Key === "timezone")?.Value).toBe("Asia/Kolkata");
    const demo = prepareDatabase({ version: 1, users: [{ User_ID: "U-1", Name: "Demo", Email: "a@goyal.demo", Department: "", Role: "", Reports_To: "", Status: "Active", Access_Role: "Admin" }], tasks: [{ Task_ID: "T-1" }] });
    expect(demo.persist).toBe(true);
    expect(demo.db.users).toHaveLength(0);
    expect(demo.db.tasks).toHaveLength(0);
    expect(addDays("2026-10-21", 1)).toBe("2026-10-22");
  });
});
