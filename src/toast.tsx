import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { ToastRegion } from "./components/ui";

const ToastContext = createContext<(message: string, tone?: "success" | "error") => void>(() => undefined);

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; tone: "success" | "error" }>>([]);
  function push(message: string, tone: "success" | "error" = "success") {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), tone === "error" ? 6000 : 3500);
  }
  const notify = useCallback(push, []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <ToastRegion toasts={toasts} onClose={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} />
    </ToastContext.Provider>
  );
}
