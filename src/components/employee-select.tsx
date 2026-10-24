import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { User } from "../domain/types";
import { inputClass } from "./ui";
import { cn } from "../lib";

export function EmployeeSelect({
  users,
  value,
  onChange,
  placeholder = "Search people",
  emptyLabel = "No people to show yet",
}: {
  users: User[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  emptyLabel?: string;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);
  const selected = users.find((user) => user.User_ID === value);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return users.filter((user) => !needle || `${user.Name} ${user.Role} ${user.Department}`.toLowerCase().includes(needle)).slice(0, 8);
  }, [query, users]);

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, []);

  return (
    <div ref={rootRef} className="relative">
      <input
        ref={inputRef}
        className={cn(inputClass, "w-full")}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        placeholder={placeholder}
        value={open ? query : selected?.Name ?? ""}
        onFocus={() => {
          const rect = inputRef.current?.getBoundingClientRect();
          if (rect) setBox({ top: rect.bottom + 4, left: rect.left, width: rect.width });
          setOpen(true);
          setQuery("");
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((index) => Math.min(index + 1, matches.length - 1));
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          }
          if (event.key === "Enter" && matches[active]) {
            event.preventDefault();
            onChange(matches[active].User_ID);
            setOpen(false);
          }
          if (event.key === "Escape") setOpen(false);
        }}
      />
      {open && box && createPortal(
        <ul
          id={listId}
          role="listbox"
          className="fixed z-50 max-h-64 overflow-auto rounded-xl border border-line bg-white p-1 shadow-lg"
          style={{ top: box.top, left: box.left, width: box.width }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {matches.length === 0 && <li className="px-2 py-2 text-[13px] text-muted">{users.length === 0 ? emptyLabel : "No matching people"}</li>}
          {matches.map((user, index) => (
            <li key={user.User_ID}>
              <button
                type="button"
                className={cn("flex w-full flex-col rounded-lg px-2 py-1.5 text-left", index === active && "bg-accent-soft")}
                onMouseEnter={() => setActive(index)}
                onClick={() => {
                  onChange(user.User_ID);
                  setOpen(false);
                }}
              >
                <span className="text-[13px] font-medium">{user.Name}</span>
                <span className="text-[12px] text-muted">{user.Role} · {user.Department}</span>
              </button>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  );
}

export function EmployeeMultiSelect({ users, value, onChange }: { users: User[]; value: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div>
      <EmployeeSelect
        users={users.filter((user) => !value.includes(user.User_ID))}
        value=""
        placeholder="Add a person"
        onChange={(id) => onChange([...value, id])}
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {value.map((id) => {
          const user = users.find((item) => item.User_ID === id);
          if (!user) return null;
          return (
            <button key={id} type="button" className="rounded-full bg-slate-100 px-2 py-1 text-[12px] text-ink" onClick={() => onChange(value.filter((item) => item !== id))}>
              {user.Name} ×
            </button>
          );
        })}
      </div>
    </div>
  );
}
