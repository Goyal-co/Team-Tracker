import type { BusinessDb, User } from "./types";
import { emptyWorkspace } from "./workspace";

export function companyFixture(now = new Date("2026-10-21T06:30:00.000Z")): BusinessDb {
  const db = emptyWorkspace(now);
  const stamp = now.toISOString();
  const users: User[] = [
    user("U-001", "Ada Admin", "ada@example.com", "Admin", ""),
    user("U-002", "Lee Lead", "lee@example.com", "Manager", "U-001"),
    user("U-003", "Mia Member", "mia@example.com", "Employee", "U-002,U-004"),
    user("U-004", "Nora North", "nora@example.com", "Manager", "U-001"),
    user("U-005", "Omar Outsider", "omar@example.com", "Manager", "U-001"),
  ];
  db.users = users;
  db.teams = [
    { Team_ID: "TM-001", Name: "Technology", Description: "Product engineering", Status: "Active", Created_At: stamp },
    { Team_ID: "TM-002", Name: "Marketing", Description: "Campaigns", Status: "Active", Created_At: stamp },
  ];
  db.members = [
    member("TM-001", "U-002", "Lead", stamp),
    member("TM-001", "U-003", "Member", stamp),
    member("TM-001", "U-004", "Member", stamp),
    member("TM-002", "U-002", "Member", stamp),
  ];
  db.projects = [
    { Project_ID: "P-001", Team_ID: "TM-001", Name: "Platform", Key: "TECH", Next_Number: 3, Status: "Active" },
    { Project_ID: "P-002", Team_ID: "TM-002", Name: "Launch", Key: "MKT", Next_Number: 2, Status: "Active" },
  ];
  db.tasks = [
    task("T-0001", "TECH-1", "Login fails on refresh", "Bug", "Critical", "TM-001", "P-001", "Platform", "U-003", "U-002", "In Progress", "2026-10-20"),
    task("T-0002", "MKT-1", "Launch announcement", "Feature", "", "TM-002", "P-002", "Launch", "U-002", "U-001", "To Do", "2026-10-24"),
  ];
  db.workflows = [
    { Task_ID: "T-0001", Reviewer_ID: "U-002", Blocked_Reason: "", Review_Note: "" },
    { Task_ID: "T-0002", Reviewer_ID: "U-001", Blocked_Reason: "", Review_Note: "" },
  ];
  return db;
}

function user(id: string, name: string, email: string, access: User["Access_Role"], reports: string): User {
  return { User_ID: id, Name: name, Email: email, Department: "", Role: access === "Employee" ? "Engineer" : "Lead", Reports_To: reports, Status: "Active", Access_Role: access };
}

function member(teamId: string, userId: string, role: "Lead" | "Member", stamp: string) {
  return { Team_ID: teamId, User_ID: userId, Member_Role: role, Status: "Active" as const, Joined_At: stamp };
}

function task(
  id: string,
  key: string,
  title: string,
  type: "Task" | "Bug" | "Feature",
  severity: "" | "Critical",
  teamId: string,
  projectId: string,
  project: string,
  owner: string,
  by: string,
  status: "To Do" | "In Progress",
  due: string,
) {
  return {
    Task_ID: id,
    Task_Title: title,
    Description: "",
    Assigned_To: owner,
    Assigned_By: by,
    Priority: "High" as const,
    Status: status,
    Start_Date: "2026-10-21",
    Due_Date: due,
    Created_At: "2026-10-21T04:30:00.000Z",
    Updated_At: "2026-10-21T04:30:00.000Z",
    Completed_At: "",
    Remarks: "",
    Project: project,
    Department: "",
    Type: type,
    Team_ID: teamId,
    Project_ID: projectId,
    Key: key,
    Severity: severity,
    Labels: type === "Bug" ? "login" : "",
    CC_User_Ids: "",
  };
}
