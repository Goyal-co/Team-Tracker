import { z } from "zod";
import { ACCESS_ROLES, MEMBER_ROLES, PRIORITIES, SEVERITIES, TASK_STATUSES, WORK_TYPES } from "./types";
import { cleanText } from "./ids";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.");
const text = (max: number) => z.string().transform(cleanText).pipe(z.string().max(max));

export const createTaskSchema = z
  .object({
    Task_Title: text(180).pipe(z.string().min(1, "Task title is required.")),
    Description: text(5000).optional().default(""),
    Assigned_To: z.string().min(1, "Choose an employee."),
    Priority: z.enum(PRIORITIES),
    Start_Date: z.union([day, z.literal("")]).optional().default(""),
    Due_Date: day,
    Team_ID: z.string().min(1, "Choose a team."),
    Project_ID: z.string().min(1, "Choose a project."),
    Type: z.enum(WORK_TYPES),
    Severity: z.enum(SEVERITIES).or(z.literal("")).optional().default(""),
    Labels: text(200).optional().default(""),
    Department: text(80).optional().default(""),
    Reviewer_ID: z.string().optional().default(""),
    Remarks: text(2000).optional().default(""),
  })
  .superRefine((value, ctx) => {
    if (value.Start_Date && value.Due_Date < value.Start_Date) {
      ctx.addIssue({ code: "custom", message: "Due date cannot be before the start date.", path: ["Due_Date"] });
    }
    if (value.Type === "Bug" && !value.Severity) {
      ctx.addIssue({ code: "custom", message: "A bug needs a severity.", path: ["Severity"] });
    }
  });

export const updateTaskSchema = z
  .object({
    Updated_At: z.string().min(1),
    Task_Title: text(180).pipe(z.string().min(1)).optional(),
    Description: text(5000).optional(),
    Assigned_To: z.string().min(1).optional(),
    Priority: z.enum(PRIORITIES).optional(),
    Start_Date: z.union([day, z.literal("")]).optional(),
    Due_Date: day.optional(),
    Labels: text(200).optional(),
    Severity: z.enum(SEVERITIES).or(z.literal("")).optional(),
    Department: text(80).optional(),
    Reviewer_ID: z.string().optional(),
    Remarks: text(2000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.Start_Date && value.Due_Date && value.Due_Date < value.Start_Date) {
      ctx.addIssue({ code: "custom", message: "Due date cannot be before the start date.", path: ["Due_Date"] });
    }
  });

export const transitionSchema = z.object({
  Updated_At: z.string().min(1),
  to: z.enum(TASK_STATUSES),
  reason: text(1000).optional().default(""),
});

export const commentSchema = z.object({
  Body: text(2000).pipe(z.string().min(1, "Write a comment before sending.")),
});

export const bulkSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
  Priority: z.enum(PRIORITIES).optional(),
  to: z.enum(TASK_STATUSES).optional(),
  reason: text(1000).optional().default(""),
});

export const meetingSchema = z
  .object({
    Meeting_Title: text(180).pipe(z.string().min(1, "Meeting title is required.")),
    Description: text(5000).optional().default(""),
    Date: day,
    Start_Time: z.string().regex(/^\d{2}:\d{2}$/),
    End_Time: z.string().regex(/^\d{2}:\d{2}$/),
    Attendees: z.array(z.string()).default([]),
    Location: text(180).optional().default(""),
    Format: z.enum(["Online", "In person"]),
    Reminder_Minutes: z.number().int().min(0).max(10080).optional().default(10),
    Updated_At: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.End_Time <= value.Start_Time) {
      ctx.addIssue({ code: "custom", message: "End time must be after the start time.", path: ["End_Time"] });
    }
    if (value.Format === "In person" && !value.Location.trim()) {
      ctx.addIssue({ code: "custom", message: "Add the place where people should meet.", path: ["Location"] });
    }
  });

export const teamSchema = z.object({
  Name: text(80).pipe(z.string().min(2, "Enter a team name.")),
  Description: text(500).optional().default(""),
});

const messageFile = {
  File_Name: z.string().trim().max(180).optional().default(""),
  Mime_Type: z.string().trim().max(120).optional().default(""),
  Content_Base64: z.string().max(6_000_000).optional().default(""),
};

export const workspaceMessageSchema = z.object({
  Body: z.string().trim().max(4000).default(""),
  ...messageFile,
}).refine((value) => value.Body.length > 0 || value.Content_Base64.length > 0, { message: "Write a message or attach a file." });

export const directMessageSchema = z.object({
  Recipient_ID: z.string().min(1, "Choose a person."),
  Body: z.string().trim().max(4000).default(""),
  ...messageFile,
}).refine((value) => value.Body.length > 0 || value.Content_Base64.length > 0, { message: "Write a message or attach a file." });

export const projectSchema = z.object({
  Team_ID: z.string().min(1, "Choose a team."),
  Name: text(80).pipe(z.string().min(2, "Enter a project name.")),
  Key: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/, "Use 2 to 10 letters or numbers, starting with a letter."),
});

export const addMemberSchema = z.object({
  User_ID: z.string().min(1, "Choose a person."),
  Member_Role: z.enum(MEMBER_ROLES),
});

export const inviteSchema = z.object({
  Email: z.string().trim().email("Enter a valid email address.").max(180),
  Team_ID: z.string().min(1, "Choose a team."),
  Access_Role: z.enum(ACCESS_ROLES),
  Member_Role: z.enum(MEMBER_ROLES),
});

export const respondInviteSchema = z.object({
  accept: z.boolean(),
});

export const userSchema = z.object({
  Name: text(120).pipe(z.string().min(1, "Name is required.")),
  Email: z.string().trim().email("Enter a valid email address.").max(180),
  Department: text(80).optional().default(""),
  Role: text(120).pipe(z.string().min(1, "Designation is required.")),
  Reports_To: z.array(z.string()).default([]),
  Status: z.enum(["Active", "Inactive"]),
  Access_Role: z.enum(ACCESS_ROLES),
  Scopes: z.array(z.string()).default([]),
});

export const profileNameSchema = z.object({
  Name: text(80)
    .pipe(z.string().min(2, "Enter the name people should see."))
    .refine((value) => !/[\[\]@()]/.test(value), "The profile name cannot include @, brackets, or parentheses."),
});

export const settingsSchema = z.object({
  workday_start: z.string().regex(/^\d{2}:\d{2}$/),
  workday_end: z.string().regex(/^\d{2}:\d{2}$/),
  workdays: z.array(z.number().int().min(0).max(6)).min(1),
});

export const attachmentSchema = z.object({
  File_Name: text(180).pipe(z.string().min(1)),
  Mime_Type: z.string().min(1).max(120),
  Content_Base64: z.string().min(1).max(6_000_000),
});

export function zodMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the form and try again.";
}
