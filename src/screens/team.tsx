import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { isOverdue, kolkataToday } from "../domain/dates";
import { canCreateTasks, managerIds } from "../domain/permissions";
import { ACCESS_ROLES, MEMBER_ROLES, type Task, type TaskStatus } from "../domain/types";
import { isPlaceholderEmail } from "../domain/ids";
import { useWorkspace } from "../state";
import { useToast } from "../toast";
import { useShell } from "../components/shell";
import { EmployeeMultiSelect, EmployeeSelect } from "../components/employee-select";
import { ActivityFeed } from "../components/activity-feed";
import { TaskBoard } from "../components/task-board";
import { Avatar, Button, Dialog, Drawer, EmptyState, Field, PageHeader, SelectInput, TextInput } from "../components/ui";

export function TeamPage() {
  const { data, createTeam, createProject, addMember, invitePerson, revokeInvite, updateTask, transitionTask } = useWorkspace();
  const shell = useShell();
  const toast = useToast();
  const navigate = useNavigate();
  const [teamId, setTeamId] = useState(data.teams.find((team) => team.Status === "Active")?.Team_ID ?? "");
  const [teamName, setTeamName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [personId, setPersonId] = useState("");
  const [email, setEmail] = useState("");
  const [memberRole, setMemberRole] = useState<(typeof MEMBER_ROLES)[number]>("Member");
  const [editing, setEditing] = useState<string | null>(null);
  const [workView, setWorkView] = useState<"board" | "list">("board");
  const admin = data.me.Access_Role === "Admin";
  const team = data.teams.find((item) => item.Team_ID === teamId);
  const projects = data.projects.filter((project) => project.Team_ID === teamId && project.Status === "Active");
  const members = data.members.filter((member) => member.Team_ID === teamId && member.Status === "Active");
  const invites = data.invites.filter((invite) => invite.Team_ID === teamId && invite.Status === "Pending");
  const canInvite = admin || data.members.some((member) => member.Team_ID === teamId && member.User_ID === data.me.User_ID && member.Status === "Active" && (member.Member_Role === "Lead" || data.me.Access_Role === "Manager"));

  async function run(action: () => Promise<unknown>, success: string) {
    try {
      await action();
      toast(success);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save that.", "error");
    }
  }

  const available = data.users.filter((user) => user.Status === "Active" && !members.some((member) => member.User_ID === user.User_ID));
  const teamTasks = data.tasks.filter((task) => task.Team_ID === teamId);
  const names = useMemo(() => new Map(data.users.map((user) => [user.User_ID, user.Name])), [data.users]);
  const canAddProject = admin || members.some((member) => member.User_ID === data.me.User_ID && member.Member_Role === "Lead");

  async function move(task: Task, to: TaskStatus) {
    const reason = to === "Blocked" ? window.prompt("Why is this blocked?") ?? "" : "";
    if (to === "Blocked" && !reason.trim()) return;
    try {
      await transitionTask(task.Task_ID, { Updated_At: task.Updated_At, to, reason });
      toast(to === "Under Review" ? "Sent to the person who assigned it." : "Work moved.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "That move is not allowed.", "error");
    }
  }

  return (
    <div>
      <PageHeader title="Workspaces" subtitle="Pick a group, add people who already have an account, or invite someone new by email." />
      <form className="mb-4 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void run(async () => { await createTeam({ Name: teamName, Description: "" }); setTeamName(""); }, "Group created. You are its lead."); }}>
        <Field label="New group"><TextInput value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="HOD or Marketing" required /></Field>
        <Button type="submit">Create group</Button>
      </form>
      {data.teams.filter((item) => item.Status === "Active").length === 0 && (
        <EmptyState title="No groups yet" body="Create a group such as HOD or Marketing. You become its lead." />
      )}
      {data.teams.filter((item) => item.Status === "Active").length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {data.teams.filter((item) => item.Status === "Active").map((item) => {
            const count = data.members.filter((member) => member.Team_ID === item.Team_ID && member.Status === "Active").length;
            return (
              <button key={item.Team_ID} type="button" className={`rounded-lg border px-3 py-2 text-left ${teamId === item.Team_ID ? "border-accent bg-accent-soft" : "border-line bg-white"}`} onClick={() => setTeamId(item.Team_ID)}>
                <span className="block text-[14px] font-semibold">{item.Name}</span>
                <span className="text-[12px] text-muted">{count} {count === 1 ? "person" : "people"}</span>
              </button>
            );
          })}
        </div>
      )}
      {team && (
        <section className="overflow-hidden rounded-xl border border-line bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
            <h2 className="text-[16px] font-semibold">{team.Name}</h2>
            <div className="flex gap-2">
              {canCreateTasks(data.me, data.members) && <Button type="button" onClick={() => shell.openCreateTask(teamId)}>Assign work</Button>}
              <Button type="button" variant="secondary" onClick={() => navigate(`/chat?group=${teamId}`)}>Open chat</Button>
            </div>
          </div>
          <div>
            <div className="border-b border-line p-4">
              <h3 className="text-[13px] font-semibold">People</h3>
              <ul className="mt-2 divide-y divide-line">
                {members.map((member) => {
                  const person = data.users.find((user) => user.User_ID === member.User_ID);
                  if (!person) return null;
                  return (
                    <li
                      key={person.User_ID}
                      className="flex items-center justify-between gap-2 py-2 text-[13px]"
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        const id = event.dataTransfer.getData("text/task-id");
                        const task = data.tasks.find((item) => item.Task_ID === id);
                        if (!task) return;
                        void run(() => updateTask(task.Task_ID, { Updated_At: task.Updated_At, Assigned_To: person.User_ID }), `Assigned to ${person.Name}. You will review it.`);
                      }}
                    >
                      <button type="button" className="min-w-0 text-left" onClick={() => navigate(`/team/${person.User_ID}`)}>
                        <span className="font-medium">{person.Name}</span>
                        <span className="ml-2 text-muted">{member.Member_Role}</span>
                      </button>
                      <span className="flex shrink-0 gap-3">
                        {person.User_ID !== data.me.User_ID && <button type="button" className="text-accent" onClick={() => navigate(`/chat?with=${person.User_ID}`)}>Chat</button>}
                        {admin && <button type="button" className="text-accent" onClick={() => setEditing(person.User_ID)}>Edit</button>}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {canInvite && (
                <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); if (!personId) return; void run(async () => { await addMember(teamId, { User_ID: personId, Member_Role: memberRole }); setPersonId(""); }, "Added to the group."); }}>
                  <div className="min-w-[220px] flex-1">
                    <Field label="Add someone already on the platform">
                      <EmployeeSelect users={available} value={personId} onChange={setPersonId} placeholder="Search people" emptyLabel="Everyone here is already in this group." />
                    </Field>
                  </div>
                  <Field label="Role">
                    <SelectInput value={memberRole} onChange={(event) => setMemberRole(event.target.value as typeof memberRole)}>{MEMBER_ROLES.map((role) => <option key={role}>{role}</option>)}</SelectInput>
                  </Field>
                  <Button type="submit" disabled={!personId}>Add</Button>
                </form>
              )}
              {canInvite && (
                <form className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4" onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => { await invitePerson({ Email: email, Team_ID: teamId, Access_Role: "Employee", Member_Role: "Member" }); setEmail(""); }, "Invitation sent. They accept it to join this group.");
                }}>
                  <div className="min-w-[220px] flex-1">
                    <Field label="Invite by email" hint="They see the request after signing in with this email, including if they already signed in.">
                      <TextInput type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" required />
                    </Field>
                  </div>
                  <Button type="submit" variant="secondary">Send invite</Button>
                </form>
              )}
              {invites.length > 0 && (
                <ul className="mt-3 space-y-2 text-[13px]">
                  {invites.map((invite) => (
                    <li key={invite.Invite_ID} className="flex items-center justify-between text-muted">
                      <span>{invite.Email} · waiting to join</span>
                      {canInvite && <button type="button" className="text-red-700" onClick={() => void run(() => revokeInvite(invite.Invite_ID), "Invite revoked.")}>Revoke</button>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[13px] font-semibold">Work</h3>
                <div className="flex rounded-[10px] border border-line bg-white p-0.5">
                  {(["board", "list"] as const).map((item) => (
                    <button key={item} type="button" className={`h-7 rounded-lg px-2 text-[12px] capitalize ${workView === item ? "bg-accent-soft font-medium text-accent" : "text-muted"}`} onClick={() => setWorkView(item)}>{item}</button>
                  ))}
                </div>
              </div>
              {teamTasks.length === 0 && <p className="mt-2 text-[13px] text-muted">No work in this group yet.</p>}
              {workView === "board" && teamTasks.length > 0 && (
                <div className="mt-3">
                  <TaskBoard tasks={teamTasks} names={names} today={kolkataToday()} onOpen={shell.openTask} onMove={(task, to) => void move(task, to)} />
                </div>
              )}
              {workView === "list" && teamTasks.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {teamTasks.map((task) => (
                    <li key={task.Task_ID} draggable onDragStart={(event) => event.dataTransfer.setData("text/task-id", task.Task_ID)} className="cursor-grab rounded-lg border border-line px-3 py-2 text-[13px] active:cursor-grabbing">
                      <button type="button" className="text-left" onClick={() => shell.openTask(task.Task_ID)}>{task.Key || task.Task_ID} · {task.Task_Title}</button>
                      <span className="mt-0.5 block text-[12px] text-muted">{task.Status} · {names.get(task.Assigned_To) || "Unassigned"}</span>
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="mt-5 text-[13px] font-semibold">Projects</h3>
              {projects.length === 0 && <p className="mt-2 text-[13px] text-muted">No projects yet.</p>}
              <ul className="mt-2 space-y-1 text-[13px]">{projects.map((project) => <li key={project.Project_ID}>{project.Key} · {project.Name}</li>)}</ul>
              {canAddProject && (
                <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void run(async () => { await createProject({ Team_ID: teamId, Name: projectName, Key: projectKey }); setProjectName(""); setProjectKey(""); }, "Project added."); }}>
                  <Field label="Project"><TextInput value={projectName} onChange={(event) => setProjectName(event.target.value)} required /></Field>
                  <Field label="Key"><TextInput value={projectKey} onChange={(event) => setProjectKey(event.target.value.toUpperCase())} placeholder="TECH" required className="w-28" /></Field>
                  <Button type="submit" variant="secondary">Add</Button>
                </form>
              )}
            </div>
          </div>
        </section>
      )}
      {editing && <UserEditor id={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function UserEditor({ id, onClose }: { id?: string; onClose: () => void }) {
  const { data, saveUser } = useWorkspace();
  const toast = useToast();
  const existing = data.users.find((user) => user.User_ID === id);
  const [name, setName] = useState(existing?.Name ?? "");
  const [email, setEmail] = useState(existing?.Email ?? "");
  const [role, setRole] = useState(existing?.Role ?? "");
  const [department, setDepartment] = useState(existing?.Department ?? "");
  const [reports, setReports] = useState(existing ? managerIds(existing) : []);
  const [access, setAccess] = useState(existing?.Access_Role ?? "Employee");
  const [status, setStatus] = useState(existing?.Status ?? "Active");
  const [scopes, setScopes] = useState(data.scopes.filter((scope) => scope.User_ID === id && scope.Scope_Type === "department").map((scope) => scope.Scope_Value));
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await saveUser({ Name: name, Email: email, Department: department, Role: role, Reports_To: reports, Status: status, Access_Role: access, Scopes: scopes }, id);
      toast(id ? "Employee updated." : "Employee added.");
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save the employee.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer title={id ? "Edit employee" : "Add employee"} onClose={onClose}>
      <form className="space-y-4 px-5 py-4" onSubmit={(event) => { event.preventDefault(); if (existing && status === "Inactive" && existing.Status === "Active") setConfirm(true); else void save(); }}>
        <Field label="Name"><TextInput value={name} onChange={(event) => setName(event.target.value)} required /></Field>
        <Field label="Email" hint={isPlaceholderEmail(email) ? "Placeholder email. Replace it with the person's Gmail before Google invitations will work." : undefined}>
          <TextInput type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </Field>
        <Field label="Designation"><TextInput value={role} onChange={(event) => setRole(event.target.value)} required /></Field>
        <Field label="Department"><TextInput value={department} onChange={(event) => setDepartment(event.target.value)} /></Field>
        <Field label="Reporting managers"><EmployeeMultiSelect users={data.users.filter((user) => user.User_ID !== id)} value={reports} onChange={setReports} /></Field>
        <Field label="Access role">
          <SelectInput value={access} onChange={(event) => setAccess(event.target.value as typeof access)}>{ACCESS_ROLES.map((item) => <option key={item}>{item}</option>)}</SelectInput>
        </Field>
        {access === "Coordinator" && (
          <Field label="Delegated departments" hint="Separate names with commas.">
            <TextInput value={scopes.join(", ")} onChange={(event) => setScopes(event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} />
          </Field>
        )}
        <Field label="Status">
          <SelectInput value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
            <option>Active</option>
            <option>Inactive</option>
          </SelectInput>
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        </div>
      </form>
      {confirm && <Dialog title={`Deactivate ${name}?`} body="They will not be able to sign in. Their existing tasks stay assigned." confirmLabel="Deactivate" danger onClose={() => setConfirm(false)} onConfirm={() => void save()} />}
    </Drawer>
  );
}

export function EmployeeProfilePage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { data, saveProfileName } = useWorkspace();
  const toast = useToast();
  const shell = useShell();
  const user = data.users.find((item) => item.User_ID === id);
  const [profileName, setProfileName] = useState(user?.Name ?? "");
  useEffect(() => {
    setProfileName(user?.Name ?? "");
  }, [user?.Name]);
  const today = kolkataToday();
  const tasks = data.tasks.filter((task) => task.Assigned_To === id);
  const activity = useMemo(() => data.activity.filter((item) => item.Actor_ID === id || item.Entity_ID === id).slice(0, 8), [data.activity, id]);
  if (!user) return <EmptyState title="Employee not available" body="This profile is outside your access, or the person is no longer in the directory." />;
  const ownProfile = user.User_ID === data.me.User_ID;
  const reports = data.users.filter((item) => managerIds(item).includes(user.User_ID));
  const managers = managerIds(user).map((managerId) => data.users.find((item) => item.User_ID === managerId)).filter((item): item is NonNullable<typeof item> => Boolean(item));
  const sections = [
    ["Active", tasks.filter((task) => task.Status !== "Completed" && !isOverdue(task, today))],
    ["Overdue", tasks.filter((task) => isOverdue(task, today))],
    ["Completed", tasks.filter((task) => task.Status === "Completed")],
  ] as const;
  return (
    <div className="mx-auto max-w-4xl">
      <Link to="/team" className="text-[13px] text-accent">Back to groups</Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Avatar name={user.Name} size={48} />
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-semibold tracking-tight">{user.Name}</h1>
          <p className="text-[13px] text-muted">{user.Role} · {user.Department} · {user.Status}</p>
          <p className="text-[12px] text-muted">{data.teams.filter((team) => data.members.some((member) => member.Team_ID === team.Team_ID && member.User_ID === user.User_ID && member.Status === "Active")).map((team) => team.Name).join(", ") || "Not in a group yet"}</p>
        </div>
        {!ownProfile && <Button type="button" onClick={() => navigate(`/chat?with=${user.User_ID}`)}>Message</Button>}
      </div>
      {ownProfile && (
        <form
          className="mt-4 rounded-xl border border-line bg-white p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void saveProfileName(profileName)
              .then(() => toast("Profile name saved. People can tag this name."))
              .catch((error: unknown) => toast(error instanceof Error ? error.message : "Could not save the profile name.", "error"));
          }}
        >
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[220px] flex-1">
              <Field label="Profile name">
                <TextInput value={profileName} onChange={(event) => setProfileName(event.target.value)} />
              </Field>
            </div>
            <Button type="submit">Save name</Button>
          </div>
          <p className="mt-2 text-[12px] text-muted">Shown on your profile and used when someone tags you.</p>
        </form>
      )}
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <section className="rounded-xl border border-line bg-white p-4">
          <h2 className="text-[13px] font-semibold">Reporting managers</h2>
          {managers.length === 0 && <p className="mt-2 text-[13px] text-muted">No manager recorded.</p>}
          {managers.map((manager) => <Link key={manager.User_ID} to={`/team/${manager.User_ID}`} className="mt-2 block text-[13px] text-accent">{manager.Name}</Link>)}
        </section>
        <section className="rounded-xl border border-line bg-white p-4">
          <h2 className="text-[13px] font-semibold">Direct reports</h2>
          {reports.length === 0 && <p className="mt-2 text-[13px] text-muted">No direct reports.</p>}
          {reports.map((report) => <Link key={report.User_ID} to={`/team/${report.User_ID}`} className="mt-2 block text-[13px] text-accent">{report.Name}</Link>)}
        </section>
      </div>
      {sections.map(([label, items]) => (
        <section key={label} className="mt-4">
          <h2 className="mb-2 text-[13px] font-semibold">{label}</h2>
          {items.length === 0 && <p className="text-[13px] text-muted">{user.User_ID === data.me.User_ID ? `No ${label.toLowerCase()} tasks.` : "No tasks visible to you."}</p>}
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-white">
            {items.map((task) => (
              <li key={task.Task_ID}><button type="button" className="block w-full px-4 py-2.5 text-left text-[13px] hover:bg-slate-50" onClick={() => shell.openTask(task.Task_ID)}>{task.Task_Title}</button></li>
            ))}
          </ul>
        </section>
      ))}
      <section className="mt-4 overflow-hidden rounded-xl border border-line bg-white">
        <header className="border-b border-line px-4 py-3 text-[13px] font-semibold">Recent activity</header>
        <ActivityFeed items={activity} users={data.users} tasks={data.tasks} meetings={data.meetings} onOpenTask={shell.openTask} onOpenMeeting={shell.openMeeting} />
      </section>
    </div>
  );
}
