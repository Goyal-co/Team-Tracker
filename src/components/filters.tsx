import { useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { cn } from "../lib";
import { Button } from "./ui";

export const filterControlClass = "w-full md:w-auto";

export function FilterBar({ children, active = 0, onReset }: { children: ReactNode; active?: number; onReset?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 md:hidden">
        <Button type="button" variant="secondary" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <SlidersHorizontal size={15} />
          {open ? "Hide filters" : "Filters"}
          {active > 0 ? ` (${active})` : ""}
        </Button>
        {active > 0 && onReset && (
          <button type="button" className="text-[13px] text-accent" onClick={onReset}>Reset</button>
        )}
      </div>
      <div className={cn("mt-2 gap-2 md:mt-0 md:flex md:flex-wrap md:items-center", open ? "grid grid-cols-1 sm:grid-cols-2" : "hidden md:flex")}>
        {children}
        {onReset && (
          <button type="button" className="hidden h-9 items-center text-[13px] text-accent md:inline-flex" onClick={onReset}>Reset</button>
        )}
      </div>
    </div>
  );
}
