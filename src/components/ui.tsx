import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../lib";

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" }) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "h-7 px-2 text-[12px]" : "h-8 px-2.5 text-[13px]",
        variant === "primary" && "bg-accent text-white hover:bg-[#0055cc]",
        variant === "secondary" && "border border-line bg-white text-ink hover:bg-slate-50",
        variant === "ghost" && "text-muted hover:bg-slate-100 hover:text-ink",
        variant === "danger" && "border border-red-200 bg-white text-red-700 hover:bg-red-50",
        className,
      )}
    />
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass = "h-9 rounded-[10px] border border-line bg-white px-3 text-[13px] text-ink outline-none placeholder:text-slate-400";

function sized(className: string | undefined, extra?: string) {
  const setsWidth = Boolean(className && /(?:^|\s)(?:w-|max-w-|min-w-)/.test(className));
  return cn(inputClass, extra, !setsWidth && "w-full", className);
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={sized(props.className)} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn("min-h-24 w-full rounded-[10px] border border-line bg-white px-3 py-2 text-[13px] text-ink outline-none", props.className)} />;
}

export function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={sized(props.className, "pr-8")} />;
}

export function Drawer({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30">
      <button className="flex-1 cursor-default" aria-label="Close" onClick={onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn("flex h-full w-full flex-col bg-white shadow-xl", wide ? "max-w-[760px]" : "max-w-[480px]")}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div>
            <h2 id={titleId} className="text-[16px] font-semibold tracking-tight">{title}</h2>
            {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
          </div>
          <button type="button" className="rounded-lg p-1 text-muted hover:bg-slate-100" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function Dialog({ title, body, confirmLabel, danger, onConfirm, onClose }: { title: string; body: string; confirmLabel: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4">
      <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-xl border border-line bg-white p-5 shadow-xl">
        <h2 className="text-[16px] font-semibold">{title}</h2>
        <p className="mt-2 text-[13px] leading-5 text-muted">{body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Keep editing</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const COLORS = ["#1d4ed8", "#0f766e", "#b45309", "#6d28d9", "#be123c", "#334155"];

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const initials = name.split(" ").filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
  let hash = 0;
  for (const char of name) hash = (hash + char.charCodeAt(0)) % COLORS.length;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white"
      style={{ width: size, height: size, background: COLORS[hash], fontSize: size < 24 ? 9 : 11 }}
      title={name}
    >
      {initials}
    </span>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-white px-6 py-10 text-center">
      <h3 className="text-[15px] font-semibold">{title}</h3>
      <p className="mx-auto mt-1 max-w-md text-[13px] text-muted">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

export function ToastRegion({ toasts, onClose }: { toasts: Array<{ id: number; message: string; tone: "success" | "error" }>; onClose: (id: number) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={cn("rounded-xl border px-3 py-2 text-[13px] shadow-lg", toast.tone === "error" ? "border-red-200 bg-white text-red-700" : "border-line bg-white text-ink")}>
          <div className="flex items-start justify-between gap-3">
            <span>{toast.message}</span>
            <button type="button" aria-label="Dismiss" onClick={() => onClose(toast.id)}><X size={14} /></button>
          </div>
        </div>
      ))}
    </div>
  );
}
