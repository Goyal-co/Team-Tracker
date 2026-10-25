import { useMemo, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { activitySentence, commentParts, personName } from "../domain/format";
import { dueLabel, formatDay, formatTime, isOverdue, kolkataToday } from "../domain/dates";
import { canEditTaskMetadata, canReview, effectiveReviewer } from "../domain/permissions";
import { allowedTargets } from "../domain/workflow";
import { PRIORITIES, SEVERITIES, type Priority, type TaskStatus, type User } from "../domain/types";
import { fileMime, fileToBase64 } from "../lib";
import { useWorkspace } from "../state";
import { useToast } from "../toast";
import { OverdueBadge, PriorityBadge, StatusBadge } from "./badges";
import { EmployeeSelect } from "./employee-select";
import { activityKind } from "./activity-feed";
import { Avatar, Button, Drawer, Field, OutsideClose, SelectInput, TextArea, TextInput } from "./ui";

export function TaskDetailDrawer({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { data, updateTask, transitionTask, comment, attach } = useWorkspace();
  const toast = useToast();
  const task = data.tasks.find((item) => item.Task_ID === taskId);
  const workflow = data.workflows.find((item) => item.Task_ID === taskId);
  const [draft, setDraft] = useState(task);
  const [reason, setReason] = useState("");
  const [ask, setAsk] = useState<"block" | "return" | null>(null);
  const [note, setNote] = useState("");
  const [caret, setCaret] = useState(0);
  const [mentionActive, setMentionActive] = useState(0);
  const [hideMentions, setHideMentions] = useState(false);
  const [busy, setBusy] = useState(false);
  const today = kolkataToday();
  const names = useMemo(() => new Map(data.users.map((user) => [user.User_ID, user.Name])), [data.users]);
  if (!task || !draft) return null;
  const record = task;
  const fields = draft;
  const editable = canEditTaskMetadata(data.me, task, data.users, data.scopes, data.members);
  const targets = allowedTargets({ actor: data.me, task, workflow, users: data.users, scopes: data.scopes, members: data.members });
  const reviewer = canReview(data.me, task, workflow, data.users, data.scopes, data.members);
  const overdue = isOverdue(task, today);
  const comments = data.comments.filter((item) => item.Task_ID === task.Task_ID);
  const files = data.attachments.filter((item) => item.Task_ID === task.Task_ID);
  const timeline = [
    ...data.activity.filter((item) => item.Entity_ID === task.Task_ID).map((item) => ({ id: item.Log_ID, at: item.Timestamp, kind: "activity" as const, actor: personName(data.users, item.Actor_ID), action: item.Action, text: activitySentence(item, data.users, data.tasks, data.meetings) })),
    ...comments.map((item) => ({ id: item.Comment_ID, at: item.Created_At, kind: "comment" as const, author: names.get(item.Author_ID) ?? "Someone", body: item.Body })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const mentionQuery = note.slice(0, caret).match(/(?:^|\s)@([^\n@]*)$/)?.[1] ?? null;
  const suggestions = mentionQuery === null || hideMentions || mentionQuery.trim().length < 2
    ? []
    : data.users.filter((user) => user.Status === "Active" && user.Name.toLowerCase().includes(mentionQuery.trim().toLowerCase())).slice(0, 6);

  function insertMention(user: User, value = note, cursor = caret) {
    const before = value.slice(0, cursor).replace(/(?:^|\s)@([^\n@]*)$/, (match) => `${match.startsWith(" ") || match.startsWith("\n") ? match[0] : ""}@[${user.Name}](${user.User_ID}) `);
    const next = `${before}${value.slice(cursor)}`;
    setNote(next);
    setCaret(before.length);
    setMentionActive(0);
  }

  function onMentionKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    const value = event.currentTarget.value;
    const cursor = event.currentTarget.selectionStart ?? value.length;
    const query = value.slice(0, cursor).match(/(?:^|\s)@([^\n@]*)$/)?.[1] ?? null;
    const matches = query === null || query.trim().length < 2
      ? []
      : data.users.filter((user) => user.Status === "Active" && user.Name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 6);
    if (!matches.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMentionActive((index) => (index + 1) % matches.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setMentionActive((index) => (index - 1 + matches.length) % matches.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      insertMention(matches[Math.min(mentionActive, matches.length - 1)], value, cursor);
    }
  }

  async function save() {
    if (!editable) return;
    setBusy(true);
    try {
      await updateTask(record.Task_ID, {
        Updated_At: record.Updated_At,
        Task_Title: fields.Task_Title,
        Description: fields.Description,
        Assigned_To: fields.Assigned_To,
        Priority: fields.Priority,
        Start_Date: fields.Start_Date,
        Due_Date: fields.Due_Date,
        Project: fields.Project,
        Department: fields.Department,
        Remarks: fields.Remarks,
        Labels: fields.Labels,
        Severity: fields.Severity,
      });
      toast("Task saved.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save the task.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function move(to: TaskStatus, because = "") {
    setBusy(true);
    try {
      await transitionTask(record.Task_ID, { Updated_At: record.Updated_At, to, reason: because });
      toast(to === "Completed" ? "Task approved." : to === "Under Review" ? "Submitted for review." : "Status updated.");
      setAsk(null);
      setReason("");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not update the status.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function sendComment() {
    if (!note.trim()) return;
    setBusy(true);
    try {
      await comment(record.Task_ID, note.trim());
      setNote("");
      toast("Update added.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not add the update.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File) {
    setBusy(true);
    try {
      await attach(record.Task_ID, { File_Name: file.name, Mime_Type: fileMime(file), Content_Base64: await fileToBase64(file) });
      toast("File attached.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not attach the file.", "error");
    } finally {
      setBusy(false);
    }
  }

  const due = dueLabel(task.Due_Date, today);
  return (
    <Drawer title={task.Key || task.Task_ID} subtitle={draft.Task_Title} onClose={onClose} wide>
      <div className="grid gap-6 px-4 py-4 md:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={task.Status} />
            <span className="inline-flex items-center rounded-[3px] bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-700">{task.Type}</span>
            <PriorityBadge priority={task.Priority} />
            {overdue && <OverdueBadge />}
          </div>
          <section className="space-y-3 rounded-lg border border-line p-3">
            <h3 className="text-[11px] font-bold uppercase tracking-wide text-muted">Description</h3>
            <Field label="Title">
              <TextInput value={draft.Task_Title} disabled={!editable} onChange={(event) => setDraft({ ...draft, Task_Title: event.target.value })} />
            </Field>
            <Field label="Details">
              <TextArea value={draft.Description} disabled={!editable} onChange={(event) => setDraft({ ...draft, Description: event.target.value })} />
            </Field>
          </section>
          <section className="space-y-3 rounded-lg border border-line p-3">
            <h3 className="text-[11px] font-bold uppercase tracking-wide text-muted">People and dates</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Owner">
              {editable ? (
                <EmployeeSelect users={data.users.filter((user) => user.Status === "Active" && data.members.some((member) => member.Team_ID === task.Team_ID && member.User_ID === user.User_ID && member.Status === "Active"))} value={draft.Assigned_To} onChange={(id) => {
                  const person = data.users.find((user) => user.User_ID === id);
                  setDraft({ ...draft, Assigned_To: id, Department: person?.Department ?? draft.Department });
                }} />
              ) : <p className="text-[13px]">{names.get(task.Assigned_To)}</p>}
            </Field>
            <Field label="Reviewed by">
              <p className="text-[13px]">{names.get(effectiveReviewer(task, workflow)) || "The person who last assigned this"}</p>
            </Field>
            <Field label="Priority">
              <SelectInput value={draft.Priority} disabled={!editable} onChange={(event) => setDraft({ ...draft, Priority: event.target.value as Priority })}>
                {PRIORITIES.map((item) => <option key={item}>{item}</option>)}
              </SelectInput>
            </Field>
            <Field label="Team">
              <p className="text-[13px]">{data.teams.find((item) => item.Team_ID === task.Team_ID)?.Name || "—"}</p>
            </Field>
            <Field label="Project">
              <p className="text-[13px]">{task.Key} · {task.Project || "—"}</p>
            </Field>
            {task.Type === "Bug" && (
              <Field label="Severity">
                <SelectInput value={draft.Severity} disabled={!editable} onChange={(event) => setDraft({ ...draft, Severity: event.target.value as typeof draft.Severity })}>
                  {SEVERITIES.map((item) => <option key={item}>{item}</option>)}
                </SelectInput>
              </Field>
            )}
            <Field label="Labels">
              <TextInput value={draft.Labels} disabled={!editable} onChange={(event) => setDraft({ ...draft, Labels: event.target.value })} placeholder="login, release" />
            </Field>
            <Field label="Start">
              <TextInput type="date" value={draft.Start_Date} disabled={!editable} onChange={(event) => setDraft({ ...draft, Start_Date: event.target.value })} />
            </Field>
            <Field label="Due">
              <TextInput type="date" value={draft.Due_Date} disabled={!editable} onChange={(event) => setDraft({ ...draft, Due_Date: event.target.value })} />
              <span className={due.overdue && task.Status !== "Completed" ? "mt-1 block text-[12px] text-red-700" : "mt-1 block text-[12px] text-muted"}>{formatDay(task.Due_Date)}</span>
            </Field>
          </div>
          <Field label="Remarks">
            <TextArea value={draft.Remarks} disabled={!editable} className="min-h-16" onChange={(event) => setDraft({ ...draft, Remarks: event.target.value })} />
          </Field>
          </section>
          {task.Status === "Blocked" && workflow?.Blocked_Reason && <p className="rounded-lg bg-rose-50 px-3 py-2 text-[13px] text-rose-800">Blocked: {workflow.Blocked_Reason}</p>}
          {workflow?.Review_Note && <p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">Last review note: {workflow.Review_Note}</p>}
          <div className="flex flex-wrap gap-2">
            {targets.includes("In Progress") && task.Status === "To Do" && <Button type="button" disabled={busy} onClick={() => void move("In Progress")}>Start task</Button>}
            {targets.includes("In Progress") && task.Status === "Blocked" && <Button type="button" disabled={busy} onClick={() => void move("In Progress")}>Resume</Button>}
            {targets.includes("Under Review") && <Button type="button" disabled={busy} onClick={() => void move("Under Review")}>{task.Type === "Bug" ? "Ready to verify" : "Submit for review"}</Button>}
            {targets.includes("Blocked") && <Button type="button" variant="secondary" disabled={busy} onClick={() => setAsk("block")}>Mark blocked</Button>}
            {task.Status === "Under Review" && reviewer && targets.includes("Completed") && <Button type="button" disabled={busy} onClick={() => void move("Completed")}>Approve</Button>}
            {task.Status === "Under Review" && reviewer && targets.includes("In Progress") && <Button type="button" variant="secondary" disabled={busy} onClick={() => setAsk("return")}>Return</Button>}
            {editable && <Button type="button" variant="secondary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save changes"}</Button>}
          </div>
          {ask && (
            <div className="rounded-xl border border-line p-3">
              <Field label={ask === "block" ? "Why is this blocked?" : "What needs to change?"}>
                <TextArea value={reason} onChange={(event) => setReason(event.target.value)} className="min-h-16" />
              </Field>
              <div className="mt-3 flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setAsk(null)}>Cancel</Button>
                <Button type="button" disabled={busy} onClick={() => void move(ask === "block" ? "Blocked" : "In Progress", reason)}>{ask === "block" ? "Mark blocked" : "Return task"}</Button>
              </div>
            </div>
          )}
        </div>
        <div className="space-y-5">
          <section>
            <h3 className="mb-2 text-[13px] font-semibold">Progress update</h3>
            <OutsideClose active={suggestions.length > 0} onClose={() => setHideMentions(true)}>
            <TextArea
              value={note}
              placeholder="Write an update. Type @ to tag someone."
              className="min-h-20"
              onChange={(event) => {
                setNote(event.target.value);
                setCaret(event.target.selectionStart ?? event.target.value.length);
                setMentionActive(0);
                setHideMentions(false);
              }}
              onClick={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
              onKeyUp={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
              onKeyDown={onMentionKey}
            />
            {suggestions.length > 0 && (
              <ul className="mt-2 overflow-hidden rounded-xl border border-line bg-white" role="listbox" aria-label="People you can tag">
                {suggestions.map((user, index) => (
                  <li key={user.User_ID}>
                    <button type="button" className={`block w-full px-3 py-2 text-left text-[13px] ${index === mentionActive ? "bg-accent-soft" : "hover:bg-slate-50"}`} onMouseDown={(event) => { event.preventDefault(); insertMention(user); }}>
                      <span className="font-medium">{user.Name}</span>
                      <span className="ml-2 text-muted">{user.Role}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            </OutsideClose>
            <div className="mt-2 flex gap-2">
              <Button type="button" variant="secondary" disabled={busy || !note.trim()} onClick={() => void sendComment()}>Comment</Button>
              <label className="inline-flex h-9 cursor-pointer items-center rounded-[10px] border border-line px-3 text-[13px]">
                Attach file
                <input type="file" className="sr-only" onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void onFile(file);
                  event.target.value = "";
                }} />
              </label>
            </div>
          </section>
          <section>
            <h3 className="mb-2 text-[13px] font-semibold">Attachments</h3>
            {files.length === 0 && <p className="text-[13px] text-muted">No files yet.</p>}
            <ul className="space-y-1">
              {files.map((file) => (
                <li key={file.Attachment_ID}>
                  <a className="text-[13px] text-accent hover:underline" href={`/api/attachments/${file.Attachment_ID}`}>{file.File_Name}</a>
                  <span className="ml-2 text-[12px] text-muted">{Math.ceil(file.Size_Bytes / 1024)} KB</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="border-t border-line pt-4">
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted">Activity</h3>
            <ol className="divide-y divide-line">
              {timeline.map((item) => {
                const kind = item.kind === "activity" ? activityKind(item.action) : { label: "Comment", dot: "bg-accent" };
                return (
                  <li key={item.id} className="flex items-start gap-3 py-3">
                    <Avatar name={item.kind === "activity" ? item.actor : item.author} size={28} />
                    <div className="min-w-0 flex-1">
                      {item.kind === "activity" ? (
                        <p className="text-[13px] leading-5">{item.text}</p>
                      ) : (
                        <p className="text-[13px] leading-5">
                          <span className="font-medium">{item.author}</span>
                          {": "}
                          <CommentText body={item.body} users={data.users} />
                        </p>
                      )}
                      <p className="mt-1 flex items-center gap-1.5 text-[12px] text-muted">
                        <span className={`h-1.5 w-1.5 rounded-full ${kind.dot}`} />
                        {kind.label}
                        <span>· {formatTime(item.at)}</span>
                      </p>
                    </div>
                  </li>
                );
              })}
              {timeline.length === 0 && <p className="py-2 text-[13px] text-muted">No activity yet.</p>}
            </ol>
          </section>
        </div>
      </div>
    </Drawer>
  );
}

function CommentText({ body, users }: { body: string; users: User[] }) {
  return (
    <>
      {commentParts(body, users).map((part, index) =>
        part.kind === "mention" ? (
          <Link key={`${part.userId}-${index}`} to={`/team/${part.userId}`} className="font-medium text-accent">@{part.label}</Link>
        ) : (
          <span key={index}>{part.value}</span>
        ),
      )}
    </>
  );
}
