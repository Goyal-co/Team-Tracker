/**
 * Sheets-native API for Goyal Workspace.
 * Deploy as a web app that executes as the owner. Identity is a verified
 * Google ID token, then a session token passed in the JSON body or ?token=.
 * Apps Script web apps cannot read custom request headers.
 *
 * Script properties:
 *   SHEETS_ID                 spreadsheet id (omit when the script is bound)
 *   GOOGLE_CLIENT_ID          OAuth client used to verify Google sign-in
 *   BOOTSTRAP_ADMIN_EMAIL     first administrator, used only while no admin exists
 */
var HEADERS = {
  USERS: ["User_ID", "Name", "Email", "Department", "Role", "Reports_To", "Status", "Access_Role"],
  TEAMS: ["Team_ID", "Name", "Description", "Status", "Created_At"],
  TEAM_MEMBERS: ["Team_ID", "User_ID", "Member_Role", "Status", "Joined_At"],
  PROJECTS: ["Project_ID", "Team_ID", "Name", "Key", "Next_Number", "Status"],
  INVITES: ["Invite_ID", "Email", "Team_ID", "Access_Role", "Member_Role", "Invited_By", "Status", "Created_At", "Responded_At"],
  TASKS: ["Task_ID", "Task_Title", "Description", "Assigned_To", "Assigned_By", "Priority", "Status", "Start_Date", "Due_Date", "Created_At", "Updated_At", "Completed_At", "Remarks", "Project", "Department", "Type", "Team_ID", "Project_ID", "Key", "Severity", "Labels"],
  MEETINGS: ["Meeting_ID", "Meeting_Title", "Description", "Organized_By", "Attendees", "Start_DateTime", "End_DateTime", "Location", "Google_Meet_Link", "Calendar_Event_ID", "Status", "Created_At", "Updated_At"],
  ACTIVITY_LOG: ["Log_ID", "Timestamp", "Actor_ID", "Action", "Entity_Type", "Entity_ID", "Old_Value", "New_Value"],
  SETTINGS: ["Key", "Value", "Description"],
  COMMENTS: ["Comment_ID", "Task_ID", "Author_ID", "Body", "Created_At"],
  ATTACHMENTS: ["Attachment_ID", "Task_ID", "File_Name", "Mime_Type", "Size_Bytes", "Uploaded_By", "Uploaded_At", "Storage_Ref"],
  NOTIFICATIONS: ["Notification_ID", "Recipient_ID", "Type", "Title", "Body", "Entity_Type", "Entity_ID", "Read_At", "Created_At"],
  TASK_WORKFLOW: ["Task_ID", "Reviewer_ID", "Blocked_Reason", "Review_Note"],
  USER_SCOPES: ["User_ID", "Scope_Type", "Scope_Value"],
  MEETING_DETAILS: ["Meeting_ID", "Reminder_Minutes", "Calendar_Link", "Invitation_Status"],
  CALENDAR_BUSY: ["User_ID", "Start", "End", "Private_Label"],
};

var NEXT_STATUS = {
  "To Do": ["In Progress", "Blocked"],
  "In Progress": ["Under Review", "Blocked", "To Do"],
  Blocked: ["In Progress", "To Do"],
  "Under Review": ["Completed", "In Progress"],
  Completed: ["In Progress"],
};

function doGet(e) {
  return handle(e, "GET");
}

function doPost(e) {
  return handle(e, "POST");
}

function handle(e, method) {
  try {
    var body = {};
    if (e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
    var path = String((e.pathInfo || body.path || (e.parameter && e.parameter.path) || "")).replace(/^\/+/, "");
    var token = String((e.parameter && e.parameter.token) || body.token || "");
    var result = dispatch(method, path, body, token);
    return json(result.body, result.status || 200);
  } catch (error) {
    return json({ error: error.message || "Request failed." }, error.status || 400);
  }
}

function dispatch(method, path, body, token) {
  if (method === "GET" && (path === "api/health" || path === "health")) return { body: { ok: true } };
  if (method === "GET" && (path === "api/system" || path === "system")) {
    return { body: { googleClientId: prop("GOOGLE_CLIENT_ID"), calendarOAuthReady: false, dataStore: "google-sheets", bootstrapConfigured: Boolean(prop("BOOTSTRAP_ADMIN_EMAIL")) } };
  }
  if (method === "POST" && path === "api/auth/google") return { body: signInGoogle(body.credential) };
  if (method === "POST" && path === "api/auth/logout") {
    if (token) {
      CacheService.getScriptCache().remove("s:" + token);
      PropertiesService.getScriptProperties().deleteProperty("s:" + token);
    }
    return { body: { ok: true } };
  }
  var actor = sessionUser(token);
  if (!actor) fail(401, "Sign in required.");
  if (method === "GET" && path === "api/bootstrap") return { body: bootstrap(actor) };
  if (method === "POST" && path === "api/teams") return { status: 201, body: { team: createTeam(actor, body) } };
  if (method === "POST" && path === "api/projects") return { status: 201, body: { project: createProject(actor, body) } };
  if (method === "POST" && path === "api/invites") return { status: 201, body: { invite: createInvite(actor, body) } };
  if (method === "POST" && path === "api/invites/respond") return { body: { invite: respondInvite(actor, body.id, body.accept) } };
  if (method === "POST" && path === "api/tasks") return { status: 201, body: { task: createTask(actor, body) } };
  if (method === "POST" && path === "api/tasks/transition") return { body: { task: transitionTask(actor, body.id, body.to, body.reason, body.Updated_At) } };
  if (method === "POST" && path === "api/tasks/update") return { body: { task: updateTask(actor, body) } };
  if (method === "POST" && path === "api/comments") return { status: 201, body: { comment: addComment(actor, body.Task_ID, body.Body) } };
  if (method === "POST" && path === "api/meetings") return { status: 201, body: createMeeting(actor, body) };
  if (method === "POST" && path === "api/meetings/update") return { body: { meeting: updateMeeting(actor, body) } };
  if (method === "POST" && path === "api/meetings/cancel") return { body: { meeting: cancelMeeting(actor, body.id, body.Updated_At) } };
  if (method === "POST" && path === "api/calendar/availability") return { body: availability(actor, body) };
  if (method === "POST" && path === "api/users") return { body: { user: saveUser(actor, body) } };
  if (method === "POST" && path === "api/notifications/read") return { body: markRead(actor, body.ids) };
  fail(404, "Unknown request.");
}

function signInGoogle(credential) {
  var clientId = prop("GOOGLE_CLIENT_ID");
  if (!clientId) fail(503, "Google Sign-In is not configured.");
  var response = UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(String(credential || "")), { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) fail(401, "Google did not accept that sign-in.");
  var info = JSON.parse(response.getContentText());
  if (info.aud !== clientId) fail(401, "This Google sign-in was issued for a different application.");
  if (String(info.email_verified) !== "true") fail(401, "That Google account is not verified.");
  var user = ensureAccount(String(info.email || "").toLowerCase(), info.name || "");
  return { token: issueSession(user.User_ID), user: user };
}

function ensureAccount(email, name) {
  var user = findByEmail(email);
  var bootstrap = String(prop("BOOTSTRAP_ADMIN_EMAIL") || "").toLowerCase();
  var users = readTable("USERS");
  var noAdmin = !users.some(function (item) { return item.Status === "Active" && item.Access_Role === "Admin"; });
  var becomesAdmin = bootstrap && email === bootstrap && noAdmin;
  if (!user) {
    user = { User_ID: nextId("USERS", "User_ID", "U-", 0), Name: name || email.split("@")[0], Email: email, Department: "", Role: "", Reports_To: "", Status: "Active", Access_Role: becomesAdmin ? "Admin" : "Employee" };
    appendRow("USERS", user);
  } else if (becomesAdmin) {
    user.Access_Role = "Admin";
    user.Status = "Active";
    replaceRow("USERS", "User_ID", user.User_ID, user);
  }
  if (user.Status !== "Active") fail(403, "This account is inactive.");
  return user;
}

function issueSession(userId) {
  var token = Utilities.getUuid() + Utilities.getUuid();
  var payload = JSON.stringify({ userId: userId, exp: Date.now() + 12 * 3600 * 1000 });
  CacheService.getScriptCache().put("s:" + token, payload, 21600);
  PropertiesService.getScriptProperties().setProperty("s:" + token, payload);
  return token;
}

function sessionUser(token) {
  if (!token) return null;
  var raw = CacheService.getScriptCache().get("s:" + token) || PropertiesService.getScriptProperties().getProperty("s:" + token);
  if (!raw) return null;
  var parsed = JSON.parse(raw);
  if (!parsed.exp || parsed.exp < Date.now()) return null;
  var user = findRow("USERS", "User_ID", parsed.userId);
  return user && user.Status === "Active" ? user : null;
}

function bootstrap(actor) {
  ensureDerivedNotifications(actor.User_ID);
  var db = loadDb();
  var tasks = db.TASKS.filter(function (task) { return canViewTask(actor, task, db); });
  var taskIds = {};
  tasks.forEach(function (task) { taskIds[task.Task_ID] = true; });
  var meetings = db.MEETINGS.filter(function (meeting) { return canViewMeeting(actor, meeting, db); });
  var meetingIds = {};
  meetings.forEach(function (meeting) { meetingIds[meeting.Meeting_ID] = true; });
  return {
    me: actor,
    users: db.USERS,
    tasks: tasks,
    workflows: db.TASK_WORKFLOW.filter(function (row) { return taskIds[row.Task_ID]; }),
    comments: db.COMMENTS.filter(function (row) { return taskIds[row.Task_ID]; }),
    meetings: meetings,
    meetingDetails: db.MEETING_DETAILS.filter(function (row) { return meetingIds[row.Meeting_ID]; }).map(parseDetail),
    notifications: db.NOTIFICATIONS.filter(function (row) { return row.Recipient_ID === actor.User_ID; }),
    activity: db.ACTIVITY_LOG.filter(function (row) { return canViewActivity(actor, row, db); }),
    settings: db.SETTINGS,
    scopes: actor.Access_Role === "Admin" ? db.USER_SCOPES : db.USER_SCOPES.filter(function (row) { return row.User_ID === actor.User_ID; }),
    googleClientId: prop("GOOGLE_CLIENT_ID"),
    calendarOAuthReady: false,
    dataStore: "google-sheets",
    bootstrapConfigured: Boolean(prop("BOOTSTRAP_ADMIN_EMAIL")),
    resetEnabled: false,
    access: hasAccess(actor) ? "workspace" : "waiting",
    teams: readTable("TEAMS"),
    members: readTable("TEAM_MEMBERS"),
    projects: readTable("PROJECTS"),
    invites: readTable("INVITES"),
    calendarConnected: true,
  };
}

function createTask(actor, input) {
  if (actor.Access_Role === "Employee") fail(403, "Employees cannot assign work.");
  var assignee = findRow("USERS", "User_ID", input.Assigned_To);
  if (!assignee || assignee.Status !== "Active") fail(400, "Choose an active employee.");
  if (!scopedIds(actor).has(assignee.User_ID)) fail(403, "You cannot assign work to that employee.");
  var project = findRow("PROJECTS", "Project_ID", input.Project_ID);
  if (!project) fail(400, "Choose a project.");
  var number = Number(project.Next_Number || 1);
  project.Next_Number = number + 1;
  replaceRow("PROJECTS", "Project_ID", project.Project_ID, project);
  var now = new Date().toISOString();
  var task = {
    Task_ID: nextId("TASKS", "Task_ID", "T-", 0),
    Task_Title: required(input.Task_Title, "Task title is required."),
    Description: input.Description || "",
    Assigned_To: assignee.User_ID,
    Assigned_By: actor.User_ID,
    Priority: input.Priority || "Medium",
    Status: "To Do",
    Start_Date: input.Start_Date || "",
    Due_Date: required(input.Due_Date, "Due date is required."),
    Created_At: now,
    Updated_At: now,
    Completed_At: "",
    Remarks: input.Remarks || "",
    Project: project.Name,
    Department: input.Department || assignee.Department,
    Type: input.Type || "Task",
    Team_ID: input.Team_ID || project.Team_ID,
    Project_ID: project.Project_ID,
    Key: project.Key + "-" + number,
    Severity: input.Type === "Bug" ? (input.Severity || "") : "",
    Labels: input.Labels || "",
  };
  appendRow("TASKS", task);
  appendRow("TASK_WORKFLOW", { Task_ID: task.Task_ID, Reviewer_ID: input.Reviewer_ID || actor.User_ID, Blocked_Reason: "", Review_Note: "" });
  log(actor.User_ID, "task.created", "task", task.Task_ID, "", task.Task_Title);
  notify(assignee.User_ID, "assignment", "New task", task.Task_Title, "task", task.Task_ID);
  return task;
}

function updateTask(actor, input) {
  return withLock(function () {
    var task = findRow("TASKS", "Task_ID", input.id);
    if (!task) fail(404, "Task not found.");
    if (!canEditMetadata(actor, task)) fail(403, "You cannot change the deadline, priority, or details of this task.");
    assertFresh(task.Updated_At, input.Updated_At);
    ["Task_Title", "Description", "Priority", "Start_Date", "Due_Date", "Project", "Department", "Remarks"].forEach(function (key) {
      if (input[key] !== undefined) task[key] = String(input[key]);
    });
    if (input.Assigned_To && input.Assigned_To !== task.Assigned_To) {
      var assignee = findRow("USERS", "User_ID", input.Assigned_To);
      if (!assignee || assignee.Status !== "Active") fail(400, "That employee is inactive.");
      if (!scopedIds(actor).has(assignee.User_ID) || actor.Access_Role === "Employee") fail(403, "You cannot assign work to that employee.");
      task.Assigned_To = assignee.User_ID;
      notify(assignee.User_ID, "assignment", "Task assigned", task.Task_Title, "task", task.Task_ID);
    }
    task.Updated_At = new Date().toISOString();
    replaceRow("TASKS", "Task_ID", task.Task_ID, task);
    log(actor.User_ID, "task.updated", "task", task.Task_ID, "", task.Task_Title);
    return task;
  });
}

function transitionTask(actor, taskId, to, reason, updatedAt) {
  return withLock(function () {
    var task = findRow("TASKS", "Task_ID", taskId);
    if (!task) fail(404, "Task not found.");
    var db = loadDb();
    var message = transitionMessage(actor, task, db, to, reason);
    if (message) fail(403, message);
    assertFresh(task.Updated_At, updatedAt);
    var previous = task.Status;
    task.Status = to;
    task.Updated_At = new Date().toISOString();
    if (to === "Completed") task.Completed_At = task.Updated_At;
    if (previous === "Completed" && to !== "Completed") task.Completed_At = "";
    replaceRow("TASKS", "Task_ID", task.Task_ID, task);
    var workflow = findRow("TASK_WORKFLOW", "Task_ID", task.Task_ID) || { Task_ID: task.Task_ID, Reviewer_ID: task.Assigned_By, Blocked_Reason: "", Review_Note: "" };
    if (to === "Blocked") workflow.Blocked_Reason = String(reason || "").trim();
    if (previous === "Under Review" && to === "In Progress") workflow.Review_Note = String(reason || "").trim();
    replaceRow("TASK_WORKFLOW", "Task_ID", task.Task_ID, workflow);
    log(actor.User_ID, "task.transition", "task", task.Task_ID, previous, to);
    if (to === "Under Review") notify(workflow.Reviewer_ID || task.Assigned_By, "review", "Ready for review", task.Task_Title, "task", task.Task_ID);
    if (previous === "Under Review") notify(task.Assigned_To, to === "Completed" ? "approved" : "returned", to === "Completed" ? "Approved" : "Returned", task.Task_Title, "task", task.Task_ID);
    return task;
  });
}

function addComment(actor, taskId, body) {
  var task = findRow("TASKS", "Task_ID", taskId);
  if (!task) fail(404, "Task not found.");
  var db = loadDb();
  if (!canViewTask(actor, task, db)) fail(403, "You cannot comment on this task.");
  var comment = { Comment_ID: nextId("COMMENTS", "Comment_ID", "C-", 1000), Task_ID: taskId, Author_ID: actor.User_ID, Body: required(body, "Write a comment."), Created_At: new Date().toISOString() };
  appendRow("COMMENTS", comment);
  log(actor.User_ID, "comment.added", "task", taskId, "", comment.Body);
  return comment;
}

function createMeeting(actor, input) {
  var ids = unique([actor.User_ID].concat(input.Attendees || []));
  ids.forEach(function (id) {
    var person = findRow("USERS", "User_ID", id);
    if (!person || person.Status !== "Active") fail(400, "Every attendee must be an active employee.");
  });
  var start = kolkataToIso(input.Date, input.Start_Time);
  var end = kolkataToIso(input.Date, input.End_Time);
  if (!(start < end)) fail(400, "End time must be after the start time.");
  var now = new Date().toISOString();
  var meeting = {
    Meeting_ID: nextId("MEETINGS", "Meeting_ID", "M-", 1000),
    Meeting_Title: required(input.Meeting_Title, "Meeting title is required."),
    Description: input.Description || "",
    Organized_By: actor.User_ID,
    Attendees: ids.filter(function (id) { return id !== actor.User_ID; }).join(","),
    Start_DateTime: start,
    End_DateTime: end,
    Location: input.Location || "",
    Google_Meet_Link: "",
    Calendar_Event_ID: "",
    Status: "Scheduled",
    Created_At: now,
    Updated_At: now,
  };
  var emails = ids.map(function (id) { return findRow("USERS", "User_ID", id).Email; });
  var warning = "";
  if (emails.some(function (email) { return String(email).toLowerCase().indexOf("@goyal.demo") >= 0; })) {
    warning = "Saved here. Google invitations were not sent because some attendees still use placeholder emails.";
  } else {
    var google = insertCalendarEvent(meeting, emails, Boolean(input.Google_Meet));
    meeting.Calendar_Event_ID = google.id;
    meeting.Google_Meet_Link = google.link || "";
  }
  appendRow("MEETINGS", meeting);
  var invitations = {};
  ids.forEach(function (id) { invitations[id] = "invited"; });
  appendRow("MEETING_DETAILS", { Meeting_ID: meeting.Meeting_ID, Reminder_Minutes: input.Reminder_Minutes || 30, Calendar_Link: "", Invitation_Status: JSON.stringify(invitations) });
  log(actor.User_ID, "meeting.created", "meeting", meeting.Meeting_ID, "", meeting.Meeting_Title);
  ids.forEach(function (id) {
    if (id !== actor.User_ID) notify(id, "meeting", "Meeting invitation", meeting.Meeting_Title, "meeting", meeting.Meeting_ID);
  });
  return { meeting: meeting, calendarWarning: warning };
}

function updateMeeting(actor, input) {
  return withLock(function () {
    var meeting = findRow("MEETINGS", "Meeting_ID", input.id);
    if (!meeting) fail(404, "Meeting not found.");
    if (!canManageMeeting(actor, meeting)) fail(403, "You cannot change this meeting.");
    if (meeting.Status === "Cancelled") fail(400, "Cancelled meetings cannot be edited.");
    assertFresh(meeting.Updated_At, input.Updated_At);
    var previousStart = meeting.Start_DateTime;
    meeting.Meeting_Title = input.Meeting_Title || meeting.Meeting_Title;
    meeting.Description = input.Description || "";
    meeting.Location = input.Location || "";
    meeting.Attendees = unique(input.Attendees || []).filter(function (id) { return id !== meeting.Organized_By; }).join(",");
    meeting.Start_DateTime = kolkataToIso(input.Date, input.Start_Time);
    meeting.End_DateTime = kolkataToIso(input.Date, input.End_Time);
    if (!(meeting.Start_DateTime < meeting.End_DateTime)) fail(400, "End time must be after the start time.");
    if (meeting.Calendar_Event_ID) {
      patchCalendarEvent(meeting, attendeeEmails(meeting));
    }
    meeting.Updated_At = new Date().toISOString();
    replaceRow("MEETINGS", "Meeting_ID", meeting.Meeting_ID, meeting);
    if (previousStart !== meeting.Start_DateTime) {
      log(actor.User_ID, "meeting.rescheduled", "meeting", meeting.Meeting_ID, previousStart, meeting.Start_DateTime);
    }
    return meeting;
  });
}

function cancelMeeting(actor, id, updatedAt) {
  return withLock(function () {
    var meeting = findRow("MEETINGS", "Meeting_ID", id);
    if (!meeting) fail(404, "Meeting not found.");
    if (!canManageMeeting(actor, meeting)) fail(403, "You cannot change this meeting.");
    assertFresh(meeting.Updated_At, updatedAt);
    if (meeting.Calendar_Event_ID) deleteCalendarEvent(meeting.Calendar_Event_ID);
    meeting.Status = "Cancelled";
    meeting.Updated_At = new Date().toISOString();
    replaceRow("MEETINGS", "Meeting_ID", meeting.Meeting_ID, meeting);
    log(actor.User_ID, "meeting.cancelled", "meeting", meeting.Meeting_ID, "Scheduled", "Cancelled");
    return meeting;
  });
}

function availability(actor, input) {
  var ids = input.attendeeIds || [];
  if (!ids.length || !input.start || !input.end || input.start >= input.end) fail(400, "Choose attendees and a valid time.");
  var db = loadDb();
  var external = {};
  var warning = "";
  var emails = ids.map(function (id) {
    var person = findRow("USERS", "User_ID", id);
    return person ? String(person.Email).toLowerCase() : "";
  }).filter(Boolean);
  try {
    var response = Calendar.Freebusy.query({ timeMin: new Date(input.start).toISOString(), timeMax: new Date(input.end).toISOString(), items: emails.map(function (email) { return { id: email }; }) });
    var calendars = response.calendars || {};
    emails.forEach(function (email) {
      var entry = calendars[email];
      if (!entry || (entry.errors && entry.errors.length)) external[email] = { state: "unknown" };
      else if (entry.busy && entry.busy.length) external[email] = { state: "busy", windows: entry.busy.map(function (item) { return { start: item.start, end: item.end }; }) };
      else external[email] = { state: "available" };
    });
  } catch (error) {
    warning = "Google Calendar could not be checked. People are unknown unless they already have a meeting here.";
    emails.forEach(function (email) { external[email] = { state: "unknown" }; });
  }
  var people = ids.map(function (id) {
    var person = findRow("USERS", "User_ID", id);
    if (!person) fail(400, "Unknown attendee.");
    var internal = knownBusy(db, id).filter(function (item) { return overlaps(item.start, item.end, input.start, input.end); });
    var outside = external[String(person.Email).toLowerCase()] || { state: "unknown" };
    var state = internal.length || outside.state === "busy" ? "busy" : outside.state === "unknown" ? "unknown" : "available";
    return { userId: id, name: person.Name, state: state, windows: internal.map(function (item) { return { start: item.start, end: item.end, source: "internal" }; }) };
  });
  return { people: people, warning: warning, live: !warning };
}

function saveUser(actor, input) {
  if (actor.Access_Role !== "Admin") fail(403, "Only an administrator can edit the directory.");
  return withLock(function () {
    var existing = input.User_ID ? findRow("USERS", "User_ID", input.User_ID) : null;
    var user = existing || { User_ID: nextId("USERS", "User_ID", "U-", 0), Status: "Active" };
    if (input.Status === "Inactive" && user.User_ID === actor.User_ID) fail(400, "You cannot deactivate your own account.");
    if (existing && existing.Access_Role === "Admin" && existing.Status === "Active") {
      var remainsAdmin = (input.Access_Role || "Admin") === "Admin" && (input.Status || "Active") === "Active";
      if (!remainsAdmin) {
        var admins = loadDb().USERS.filter(function (row) { return row.Access_Role === "Admin" && row.Status === "Active" && row.User_ID !== user.User_ID; });
        if (!admins.length) fail(400, "The last active administrator cannot be removed.");
      }
    }
    user.Name = required(input.Name, "Name is required.");
    user.Email = required(input.Email, "Email is required.");
    user.Department = required(input.Department, "Department is required.");
    user.Role = required(input.Role, "Designation is required.");
    user.Reports_To = (input.Reports_To || []).join(",");
    user.Status = input.Status || user.Status || "Active";
    user.Access_Role = input.Access_Role || user.Access_Role || "Employee";
    if (existing) replaceRow("USERS", "User_ID", user.User_ID, user);
    else appendRow("USERS", user);
    log(actor.User_ID, existing ? "user.updated" : "user.created", "user", user.User_ID, "", user.Name);
    return user;
  });
}

function markRead(actor, ids) {
  var rows = readTable("NOTIFICATIONS");
  var now = new Date().toISOString();
  rows.forEach(function (row) {
    if (row.Recipient_ID !== actor.User_ID || row.Read_At) return;
    if (ids === "all" || (ids || []).indexOf(row.Notification_ID) >= 0) row.Read_At = now;
  });
  writeTable("NOTIFICATIONS", rows);
  return { ok: true };
}

function transitionMessage(actor, task, db, to, reason) {
  var allowed = NEXT_STATUS[task.Status] || [];
  if (allowed.indexOf(to) < 0) return "Cannot move a task from " + task.Status + " to " + to + ".";
  if (to === "Blocked" && !String(reason || "").trim()) return "Blocked tasks require a reason.";
  if (task.Status === "Under Review" && (to === "Completed" || to === "In Progress")) {
    if (!canReview(actor, task, db)) return "You cannot review this task.";
    if (to === "In Progress" && !String(reason || "").trim()) return "Add a note explaining what needs to change.";
    return "";
  }
  if (task.Status === "Completed" && to === "In Progress") {
    return actor.Access_Role === "Admin" ? "" : "Only an administrator can reopen a completed task.";
  }
  if (!canWorkTask(actor, task, db)) return "You cannot update this task.";
  return "";
}

function canReview(actor, task, db) {
  if (actor.Access_Role === "Admin") return true;
  var workflow = db.TASK_WORKFLOW.filter(function (row) { return row.Task_ID === task.Task_ID; })[0];
  var reviewer = (workflow && workflow.Reviewer_ID) || task.Assigned_By;
  if (reviewer === actor.User_ID) return true;
  return actor.Access_Role === "Manager" && scopedIds(actor, db).has(task.Assigned_To);
}

function canWorkTask(actor, task, db) {
  if (actor.Access_Role === "Admin" || task.Assigned_To === actor.User_ID) return true;
  return (actor.Access_Role === "Manager" || actor.Access_Role === "Coordinator") && scopedIds(actor, db).has(task.Assigned_To);
}

function canViewTask(actor, task, db) {
  if (actor.Access_Role === "Admin" || task.Assigned_To === actor.User_ID || task.Assigned_By === actor.User_ID) return true;
  var workflow = db.TASK_WORKFLOW.filter(function (row) { return row.Task_ID === task.Task_ID; })[0];
  if (workflow && workflow.Reviewer_ID === actor.User_ID) return true;
  return (actor.Access_Role === "Manager" || actor.Access_Role === "Coordinator") && scopedIds(actor, db).has(task.Assigned_To);
}

function canViewMeeting(actor, meeting, db) {
  if (actor.Access_Role === "Admin") return true;
  var people = meetingPeople(meeting);
  if (people.indexOf(actor.User_ID) >= 0) return true;
  var scope = scopedIds(actor, db);
  return (actor.Access_Role === "Manager" || actor.Access_Role === "Coordinator") && people.some(function (id) { return scope.has(id); });
}

function canViewActivity(actor, row, db) {
  if (actor.Access_Role === "Admin") return true;
  if (row.Entity_Type === "task") {
    var task = db.TASKS.filter(function (item) { return item.Task_ID === row.Entity_ID; })[0];
    return task ? canViewTask(actor, task, db) : false;
  }
  if (row.Entity_Type === "meeting") {
    var meeting = db.MEETINGS.filter(function (item) { return item.Meeting_ID === row.Entity_ID; })[0];
    return meeting ? canViewMeeting(actor, meeting, db) : false;
  }
  return false;
}

function canEditMetadata(actor, task) {
  if (actor.Access_Role === "Employee") return false;
  if (actor.Access_Role === "Admin") return true;
  return scopedIds(actor).has(task.Assigned_To);
}

function canManageMeeting(actor, meeting) {
  if (actor.Access_Role === "Admin" || meeting.Organized_By === actor.User_ID) return true;
  return (actor.Access_Role === "Manager" || actor.Access_Role === "Coordinator") && scopedIds(actor).has(meeting.Organized_By);
}

function scopedIds(actor, db) {
  db = db || loadDb();
  var ids = {};
  if (actor.Access_Role === "Admin") {
    db.USERS.forEach(function (user) { ids[user.User_ID] = true; });
    return { has: function (id) { return Boolean(ids[id]); } };
  }
  ids[actor.User_ID] = true;
  if (actor.Access_Role !== "Employee") {
    var children = {};
    db.USERS.forEach(function (user) {
      String(user.Reports_To || "").split(",").forEach(function (managerId) {
        if (!managerId) return;
        children[managerId] = children[managerId] || [];
        children[managerId].push(user.User_ID);
      });
    });
    var stack = (children[actor.User_ID] || []).slice();
    var seen = {};
    while (stack.length) {
      var id = stack.pop();
      if (seen[id]) continue;
      seen[id] = true;
      ids[id] = true;
      (children[id] || []).forEach(function (child) { stack.push(child); });
    }
  }
  if (actor.Access_Role === "Coordinator") {
    db.USER_SCOPES.forEach(function (scope) {
      if (scope.User_ID !== actor.User_ID) return;
      if (scope.Scope_Type === "user") ids[scope.Scope_Value] = true;
      if (scope.Scope_Type === "department") db.USERS.forEach(function (user) { if (user.Department === scope.Scope_Value) ids[user.User_ID] = true; });
    });
  }
  return { has: function (id) { return Boolean(ids[id]); } };
}

function knownBusy(db, userId) {
  var windows = [];
  db.MEETINGS.forEach(function (meeting) {
    if (meeting.Status !== "Scheduled") return;
    if (meetingPeople(meeting).indexOf(userId) < 0) return;
    windows.push({ start: meeting.Start_DateTime, end: meeting.End_DateTime });
  });
  db.CALENDAR_BUSY.forEach(function (busy) {
    if (busy.User_ID === userId) windows.push({ start: busy.Start, end: busy.End });
  });
  return windows;
}

function ensureDerivedNotifications(userId) {
  var today = Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyy-MM-dd");
  var tomorrow = Utilities.formatDate(new Date(Date.now() + 86400000), "Asia/Kolkata", "yyyy-MM-dd");
  var tasks = readTable("TASKS").filter(function (task) { return task.Assigned_To === userId && task.Status !== "Completed"; });
  var existing = readTable("NOTIFICATIONS");
  tasks.forEach(function (task) {
    var type = task.Due_Date < today ? "overdue" : task.Due_Date === today || task.Due_Date === tomorrow ? "due-soon" : "";
    if (!type) return;
    var already = existing.some(function (row) { return row.Recipient_ID === userId && row.Entity_ID === task.Task_ID && row.Type === type && !row.Read_At; });
    if (!already) notify(userId, type, type === "overdue" ? "Overdue" : "Due soon", task.Task_Title, "task", task.Task_ID);
  });
}

function insertCalendarEvent(meeting, emails, meet) {
  var minutes = Number(meeting.Reminder_Minutes || 10) || 10;
  var resource = {
    summary: meeting.Meeting_Title,
    description: meeting.Description,
    location: meet ? meeting.Location || "Google Meet" : meeting.Location,
    start: { dateTime: meeting.Start_DateTime, timeZone: "Asia/Kolkata" },
    end: { dateTime: meeting.End_DateTime, timeZone: "Asia/Kolkata" },
    attendees: emails.map(function (email) { return { email: email }; }),
    transparency: "opaque",
    reminders: {
      useDefault: false,
      overrides: meet
        ? [{ method: "email", minutes: minutes }, { method: "popup", minutes: minutes }]
        : [{ method: "popup", minutes: minutes }],
    },
  };
  if (meet) resource.conferenceData = { createRequest: { requestId: Utilities.getUuid(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
  var created = Calendar.Events.insert(resource, "primary", { conferenceDataVersion: 1, sendUpdates: "all" });
  if (meet && !created.hangoutLink) fail(502, "Google Calendar did not return a Meet link.");
  return { id: created.id, link: meet ? created.hangoutLink || "" : "" };
}

function patchCalendarEvent(meeting, emails) {
  Calendar.Events.patch({
    summary: meeting.Meeting_Title,
    description: meeting.Description,
    location: meeting.Location,
    start: { dateTime: meeting.Start_DateTime },
    end: { dateTime: meeting.End_DateTime },
    attendees: emails.map(function (email) { return { email: email }; }),
  }, "primary", meeting.Calendar_Event_ID, { sendUpdates: "all" });
}

function deleteCalendarEvent(eventId) {
  Calendar.Events.remove("primary", eventId, { sendUpdates: "all" });
}

function attendeeEmails(meeting) {
  return meetingPeople(meeting).map(function (id) { return findRow("USERS", "User_ID", id).Email; }).filter(Boolean);
}

function meetingPeople(meeting) {
  return unique([meeting.Organized_By].concat(String(meeting.Attendees || "").split(",").filter(Boolean)));
}

function spreadsheet() {
  ensureWorkspace();
  var id = prop("SHEETS_ID");
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
  Object.keys(HEADERS).forEach(function (name) {
    var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS[name]);
  });
  return ss;
}

function ensureWorkspace() {
  var ss = prop("SHEETS_ID") ? SpreadsheetApp.openById(prop("SHEETS_ID")) : SpreadsheetApp.getActive();
  var settings = ss.getSheetByName("SETTINGS") || ss.insertSheet("SETTINGS");
  if (settings.getLastRow() === 0) settings.appendRow(HEADERS.SETTINGS);
  if (settings.getLastRow() < 2) {
    settings.appendRow(["workday_start", "09:30", "Working day start in Asia/Kolkata"]);
    settings.appendRow(["workday_end", "18:30", "Working day end in Asia/Kolkata"]);
    settings.appendRow(["workdays", "1,2,3,4,5", "Monday is 1"]);
    settings.appendRow(["timezone", "Asia/Kolkata", "Workspace timezone"]);
  }
}

function hasAccess(actor) {
  if (actor.Access_Role === "Admin" && actor.Status === "Active") return true;
  return readTable("TEAM_MEMBERS").some(function (member) { return member.User_ID === actor.User_ID && member.Status === "Active"; });
}

function createTeam(actor, input) {
  if (actor.Access_Role !== "Admin") fail(403, "Only an administrator can create a team.");
  var team = { Team_ID: nextId("TEAMS", "Team_ID", "TM-", 0), Name: required(input.Name, "Enter a team name."), Description: input.Description || "", Status: "Active", Created_At: new Date().toISOString() };
  appendRow("TEAMS", team);
  return team;
}

function createProject(actor, input) {
  var key = String(input.Key || "").toUpperCase();
  var project = { Project_ID: nextId("PROJECTS", "Project_ID", "P-", 0), Team_ID: required(input.Team_ID, "Choose a team."), Name: required(input.Name, "Enter a project name."), Key: key, Next_Number: 1, Status: "Active" };
  appendRow("PROJECTS", project);
  return project;
}

function createInvite(actor, input) {
  var invite = { Invite_ID: nextId("INVITES", "Invite_ID", "I-", 0), Email: String(input.Email || "").toLowerCase(), Team_ID: required(input.Team_ID, "Choose a team."), Access_Role: input.Access_Role || "Employee", Member_Role: input.Member_Role || "Member", Invited_By: actor.User_ID, Status: "Pending", Created_At: new Date().toISOString(), Responded_At: "" };
  if (!invite.Email) fail(400, "Enter an email address.");
  appendRow("INVITES", invite);
  return invite;
}

function respondInvite(actor, inviteId, accept) {
  var invite = findRow("INVITES", "Invite_ID", inviteId);
  if (!invite || invite.Status !== "Pending") fail(404, "That invite is no longer pending.");
  if (String(invite.Email).toLowerCase() !== String(actor.Email).toLowerCase()) fail(403, "This invite was sent to a different email.");
  invite.Status = accept ? "Accepted" : "Declined";
  invite.Responded_At = new Date().toISOString();
  replaceRow("INVITES", "Invite_ID", invite.Invite_ID, invite);
  if (accept) appendRow("TEAM_MEMBERS", { Team_ID: invite.Team_ID, User_ID: actor.User_ID, Member_Role: invite.Member_Role, Status: "Active", Joined_At: invite.Responded_At });
  return invite;
}

function readTable(name) {
  var sheet = spreadsheet().getSheetByName(name);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0].map(function (header) { return String(header).trim(); });
  return values.slice(1).filter(function (row) { return row.some(function (cell) { return String(cell || "").trim() !== ""; }); }).map(function (row) {
    var record = {};
    headers.forEach(function (header, index) { record[header] = String(row[index] == null ? "" : row[index]); });
    return record;
  });
}

function writeTable(name, rows) {
  var sheet = spreadsheet().getSheetByName(name);
  sheet.clearContents();
  var values = [HEADERS[name]].concat(rows.map(function (row) { return HEADERS[name].map(function (header) { return row[header] == null ? "" : String(row[header]); }); }));
  sheet.getRange(1, 1, values.length, HEADERS[name].length).setValues(values);
}

function appendRow(name, row) {
  spreadsheet().getSheetByName(name).appendRow(HEADERS[name].map(function (header) { return row[header] == null ? "" : String(row[header]); }));
}

function replaceRow(name, idField, id, row) {
  var rows = readTable(name);
  var found = false;
  rows = rows.map(function (item) {
    if (item[idField] !== id) return item;
    found = true;
    return row;
  });
  if (!found) rows.push(row);
  writeTable(name, rows);
}

function findRow(name, field, value) {
  return readTable(name).filter(function (row) { return row[field] === value; })[0] || null;
}

function findByEmail(email) {
  var target = String(email || "").toLowerCase();
  return readTable("USERS").filter(function (user) { return String(user.Email).toLowerCase() === target; })[0] || null;
}

function loadDb() {
  var db = {};
  Object.keys(HEADERS).forEach(function (name) { db[name] = readTable(name); });
  return db;
}

function nextId(table, field, prefix, floor) {
  var max = floor;
  readTable(table).forEach(function (row) {
    var match = new RegExp("^" + prefix + "(\\d+)$").exec(row[field] || "");
    if (match) max = Math.max(max, Number(match[1]));
  });
  return prefix + String(max + 1).padStart(4, "0");
}

function log(actorId, action, entityType, entityId, oldValue, newValue) {
  appendRow("ACTIVITY_LOG", { Log_ID: "L-" + Utilities.getUuid().slice(0, 8), Timestamp: new Date().toISOString(), Actor_ID: actorId, Action: action, Entity_Type: entityType, Entity_ID: entityId, Old_Value: oldValue || "", New_Value: newValue || "" });
}

function notify(recipientId, type, title, body, entityType, entityId) {
  if (!recipientId) return;
  appendRow("NOTIFICATIONS", { Notification_ID: "N-" + Utilities.getUuid().slice(0, 8), Recipient_ID: recipientId, Type: type, Title: title, Body: body, Entity_Type: entityType, Entity_ID: entityId, Read_At: "", Created_At: new Date().toISOString() });
}

function parseDetail(row) {
  var invitations = {};
  try { invitations = JSON.parse(row.Invitation_Status || "{}"); } catch (error) { invitations = {}; }
  return { Meeting_ID: row.Meeting_ID, Reminder_Minutes: Number(row.Reminder_Minutes || 30), Calendar_Link: row.Calendar_Link || "", Invitation_Status: invitations };
}

function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function assertFresh(current, expected) {
  if (expected && current !== expected) fail(409, "Someone else updated this. Refresh and try again.");
}

function kolkataToIso(day, time) {
  return new Date(String(day) + "T" + String(time) + ":00+05:30").toISOString();
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function unique(values) {
  var seen = {};
  return values.filter(function (value) {
    if (!value || seen[value]) return false;
    seen[value] = true;
    return true;
  });
}

function required(value, message) {
  var text = String(value || "").trim();
  if (!text) fail(400, message);
  return text;
}

function prop(name) {
  return PropertiesService.getScriptProperties().getProperty(name) || "";
}

function fail(status, message) {
  var error = new Error(message);
  error.status = status;
  throw error;
}

function json(body, status) {
  var output = ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
  if (status && status !== 200) output = ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
  return output;
}

