import { formatDay, isOverdue } from "../domain/dates";
import type { Task, TaskStatus } from "../domain/types";
import { TASK_STATUSES } from "../domain/types";
import { PriorityBadge, STATUS_DOT } from "./badges";
import { Avatar } from "./ui";

export function TaskBoard({
  tasks,
  names,
  today,
  onOpen,
  onMove,
}: {
  tasks: Task[];
  names: Map<string, string>;
  today: string;
  onOpen: (id: string) => void;
  onMove: (task: Task, to: TaskStatus) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {TASK_STATUSES.map((status) => {
        const column = tasks.filter((task) => task.Status === status);
        return (
          <section
            key={status}
            className="min-w-0 rounded-lg bg-[#EBECF0] p-2"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const id = event.dataTransfer.getData("text/task-id");
              const task = tasks.find((item) => item.Task_ID === id);
              if (task && task.Status !== status) onMove(task, status);
            }}
          >
            <h2 className="flex items-center gap-2 px-1 py-1 text-[12px] font-semibold uppercase tracking-wide text-muted">
              <span className={`h-2 w-2 rounded-full ${STATUS_DOT[status]}`} />
              {status}
              <span className="font-medium normal-case tracking-normal">{column.length}</span>
            </h2>
            <div className="space-y-2">
              {column.map((task) => {
                const late = isOverdue(task, today);
                const assignee = names.get(task.Assigned_To) ?? "Unassigned";
                return (
                  <article
                    key={task.Task_ID}
                    draggable
                    onDragStart={(event) => event.dataTransfer.setData("text/task-id", task.Task_ID)}
                    className={`cursor-grab overflow-hidden rounded-md border border-line bg-white active:cursor-grabbing ${late ? "border-l-4 border-l-red-500" : ""}`}
                  >
                    <button type="button" className="block w-full p-2.5 text-left" onClick={() => onOpen(task.Task_ID)}>
                      <span className="block text-[11px] font-semibold text-accent">{task.Key || task.Task_ID}</span>
                      <span className="mt-0.5 block text-[13px] font-medium leading-5">{task.Task_Title}</span>
                      <span className="mt-2 flex items-center justify-between gap-2">
                        <PriorityBadge priority={task.Priority} />
                        <span className="flex items-center gap-1.5 text-[11px] text-muted">
                          <span>{task.Due_Date ? formatDay(task.Due_Date) : "No date"}</span>
                          <Avatar name={assignee} size={20} />
                        </span>
                      </span>
                    </button>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
