import { describe, expect, it } from "vitest";
import { companyFixture } from "../src/domain/fixture";
import type { User } from "../src/domain/types";
import { addComment, addTeamMember, createInvite, createTask, createTeam, postDirectMessage, postWorkspaceMessage, renameSelf, transitionTask, visibleData } from "./actions";

const NOW = new Date("2026-10-21T06:30:00.000Z");

describe("workspace actions", () => {
  it("stops an employee changing a deadline and completing without review", () => {
    const db = companyFixture(NOW);
    const mia = db.users.find((user) => user.User_ID === "U-003") as User;
    const task = db.tasks.find((item) => item.Task_ID === "T-0001");
    expect(() => transitionTask(db, mia, "T-0001", "Completed", "", task?.Updated_At || "")).toThrow(/cannot review|Cannot move/i);
    expect(() => createTask(db, mia, taskInput())).toThrow(/cannot create/i);
  });

  it("issues the next project key and notifies a mention", () => {
    const db = companyFixture(NOW);
    const lee = db.users.find((user) => user.User_ID === "U-002") as User;
    const created = createTask(db, lee, taskInput());
    expect(created.Key).toBe("TECH-3");
    expect(db.projects.find((project) => project.Project_ID === "P-001")?.Next_Number).toBe(4);
    addComment(db, lee, created.Task_ID, "Please check @[Mia Member](U-003)");
    expect(db.notifications.some((item) => item.Type === "mentioned" && item.Recipient_ID === "U-003")).toBe(true);
  });

  it("keeps a signed-in person out until they accept, and rejects a duplicate profile name", () => {
    const db = companyFixture(NOW);
    const lee = db.users.find((user) => user.User_ID === "U-002") as User;
    const omar = db.users.find((user) => user.User_ID === "U-005") as User;
    expect(() => createInvite(db, lee, { Email: "omar@example.com", Team_ID: "TM-002", Access_Role: "Employee", Member_Role: "Member" })).toThrow(/already has an account/i);
    expect(() => createTask(db, omar, taskInput())).toThrow(/invite/i);
    addTeamMember(db, lee, "TM-002", omar.User_ID, "Member");
    expect(db.members.some((member) => member.User_ID === "U-005" && member.Team_ID === "TM-002" && member.Status === "Active")).toBe(true);
    expect(createInvite(db, lee, { Email: "new.person@example.com", Team_ID: "TM-002", Access_Role: "Employee", Member_Role: "Member" }).Status).toBe("Pending");
    renameSelf(db, omar, "Omar North");
    expect(() => renameSelf(db, lee, "omar north")).toThrow(/already used/i);
  });

  it("lets someone belong to another group and keeps a direct chat private", () => {
    const db = companyFixture(NOW);
    const mia = db.users.find((user) => user.User_ID === "U-003") as User;
    const lee = db.users.find((user) => user.User_ID === "U-002") as User;
    const ada = db.users.find((user) => user.User_ID === "U-001") as User;
    const created = createTeam(db, mia, { Name: "Design", Description: "" });
    expect(db.members.filter((member) => member.User_ID === "U-003" && member.Status === "Active").map((member) => member.Team_ID).sort()).toEqual(["TM-001", created.Team_ID].sort());
    postWorkspaceMessage(db, mia, "TM-001", "Hi @[Lee](U-002)");
    expect(db.notifications.some((item) => item.Type === "mentioned" && item.Recipient_ID === "U-002" && item.Entity_Type === "team" && item.Entity_ID === "TM-001")).toBe(true);
    postDirectMessage(db, mia, lee.User_ID, "Hello");
    expect(visibleData(db, mia).messages.some((item) => item.Body === "Hello")).toBe(true);
    expect(visibleData(db, lee).messages.some((item) => item.Body === "Hello")).toBe(true);
    expect(visibleData(db, ada).messages.some((item) => item.Body === "Hello")).toBe(false);
  });
});

function taskInput() {
  return {
    Task_Title: "Refresh token expiry",
    Description: "",
    Assigned_To: "U-003",
    Priority: "High" as const,
    Start_Date: "2026-10-21",
    Due_Date: "2026-10-24",
    Team_ID: "TM-001",
    Project_ID: "P-001",
    Type: "Bug" as const,
    Severity: "High" as const,
    Labels: "auth",
    Department: "",
    Reviewer_ID: "U-002",
    Remarks: "",
  };
}
