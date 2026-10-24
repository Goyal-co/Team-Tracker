import { useEffect, useMemo, useState } from "react";
import { formatDay, kolkataToday, addDays } from "../domain/dates";
import { canCreateTasks } from "../domain/permissions";
import { SEVERITIES, WORK_TYPES, type Priority, type WorkType } from "../domain/types";
import { useWorkspace } from "../state";
import { useToast } from "../toast";
import { EmployeeSelect } from "./employee-select";
import { Button, Drawer, Field, SelectInput, TextArea, TextInput } from "./ui";

const PRIORITIES: Priority[] = ["Low", "Medium", "High", "Urgent"];

export function TaskCreateDrawer({ onClose, onCreated, initialTeamId = "" }: { onClose: () => void; onCreated: (id: string) => void; initialTeamId?: string }) {
  const { data, createTask } = useWorkspace();
  const toast = useToast();
  const today = kolkataToday();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState("");
  const [teamId, setTeamId] = useState(initialTeamId);
  const [projectId, setProjectId] = useState("");
  const [type, setType] = useState<WorkType>("Task");
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number] | "">("");
  const [labels, setLabels] = useState("");
  const [priority, setPriority] = useState<Priority>("Medium");
  const [start, setStart] = useState(today);
  const [due, setDue] = useState(addDays(today, 1));
  const [remarks, setRemarks] = useState("");
  const [saving, setSaving] = useState(false);
  const teams = data.teams.filter((team) => team.Status === "Active" && (data.me.Access_Role === "Admin" || data.members.some((member) => member.Team_ID === team.Team_ID && member.User_ID === data.me.User_ID && member.Status === "Active")));
  const projects = data.projects.filter((project) => project.Team_ID === teamId && project.Status === "Active");
  const people = data.users.filter((user) => user.Status === "Active" && data.members.some((member) => member.User_ID === user.User_ID && member.Team_ID === teamId && member.Status === "Active"));
  const firstTeamId = teams[0]?.Team_ID ?? "";
  useEffect(() => {
    if (!teamId && firstTeamId) setTeamId(firstTeamId);
  }, [teamId, firstTeamId]);
  const assigneeUser = people.find((user) => user.User_ID === assignee);

  async function submit(another: boolean) {
    setSaving(true);
    try {
      const task = await createTask({
        Task_Title: title,
        Description: description,
        Assigned_To: assignee,
        Priority: priority,
        Start_Date: start,
        Due_Date: due,
        Team_ID: teamId,
        Project_ID: projectId,
        Type: type,
        Severity: type === "Bug" ? severity : "",
        Labels: labels,
        Department: assigneeUser?.Department ?? "",
        Reviewer_ID: "",
        Remarks: remarks,
      });
      toast(`${task.Key} assigned to ${assigneeUser?.Name ?? "the owner"}.`);
      if (another) {
        setTitle("");
        setDescription("");
        setRemarks("");
      } else {
        onCreated(task.Task_ID);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not create the task.", "error");
    } finally {
      setSaving(false);
    }
  }

  if (!canCreateTasks(data.me)) return null;
  return (
    <Drawer title={`Create ${type.toLowerCase()}`} subtitle={`Assigned by ${data.me.Name}`} onClose={onClose}>
      <form
        className="space-y-4 px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <Field label="Title">
          <TextInput value={title} onChange={(event) => setTitle(event.target.value)} required autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <SelectInput value={type} onChange={(event) => setType(event.target.value as WorkType)}>
              {WORK_TYPES.map((item) => <option key={item}>{item}</option>)}
            </SelectInput>
          </Field>
          <Field label="Workspace">
            <SelectInput value={teamId} onChange={(event) => { setTeamId(event.target.value); setProjectId(""); setAssignee(""); }} required>
              <option value="">Choose</option>
              {teams.map((team) => <option key={team.Team_ID} value={team.Team_ID}>{team.Name}</option>)}
            </SelectInput>
          </Field>
        </div>
        <Field label="Project">
          <SelectInput value={projectId} onChange={(event) => setProjectId(event.target.value)} required>
            <option value="">Choose</option>
            {projects.map((project) => <option key={project.Project_ID} value={project.Project_ID}>{project.Key} · {project.Name}</option>)}
          </SelectInput>
        </Field>
        {teams.length === 0 && <p className="text-[13px] text-muted">Create a group under Workspaces, then add the people who should take the work.</p>}
        <Field label="Description">
          <TextArea value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <Field label="Assign to">
          <EmployeeSelect
            users={people}
            value={assignee}
            onChange={setAssignee}
            emptyLabel={teamId ? "Nobody else is in this group yet. Invite them from the workspace." : "Choose a workspace first."}
          />
        </Field>
        <p className="text-[12px] leading-5 text-muted">Work stays in this group and can only be assigned to someone in it. They update it, then you review it.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            <SelectInput value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>
              {PRIORITIES.map((item) => <option key={item}>{item}</option>)}
            </SelectInput>
          </Field>
          {type === "Bug" ? (
            <Field label="Severity">
              <SelectInput value={severity} onChange={(event) => setSeverity(event.target.value as typeof severity)} required>
                <option value="">Choose</option>
                {SEVERITIES.map((item) => <option key={item}>{item}</option>)}
              </SelectInput>
            </Field>
          ) : (
            <Field label="Labels">
              <TextInput value={labels} onChange={(event) => setLabels(event.target.value)} placeholder="release, api" />
            </Field>
          )}
        </div>
        {type === "Bug" && (
          <Field label="Labels">
            <TextInput value={labels} onChange={(event) => setLabels(event.target.value)} placeholder="login, release" />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start date">
            <TextInput type="date" value={start} onChange={(event) => setStart(event.target.value)} />
          </Field>
          <Field label="Due date">
            <TextInput type="date" value={due} onChange={(event) => setDue(event.target.value)} required />
          </Field>
        </div>
        <Field label="Remarks">
          <TextArea value={remarks} onChange={(event) => setRemarks(event.target.value)} className="min-h-16" />
        </Field>
        <p className="text-[12px] text-muted">Due {due ? formatDay(due) : "date required"}.</p>
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="secondary" disabled={saving} onClick={() => void submit(true)}>Create & add another</Button>
          <Button type="submit" disabled={saving}>{saving ? "Creating…" : `Create ${type.toLowerCase()}`}</Button>
        </div>
      </form>
    </Drawer>
  );
}

export function useNames() {
  const { data } = useWorkspace();
  return useMemo(() => new Map(data.users.map((user) => [user.User_ID, user.Name])), [data.users]);
}
