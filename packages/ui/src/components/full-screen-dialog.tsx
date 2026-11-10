import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "./button";

export function FullScreenDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const focused = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const node = dialog.current!;
    if (typeof node?.showModal === "function") node.showModal();
    return () => {
      if (typeof node?.close === "function") node.close();
      document.body.style.overflow = overflow;
      focused?.focus();
    };
  }, []);
  return <dialog ref={dialog} aria-labelledby={heading} aria-modal="true"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    className="fixed inset-0 m-0 h-[100dvh] max-h-none w-screen max-w-none border-0 bg-[var(--background)] p-0 text-[var(--foreground)] backdrop:bg-black/40">
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--card)] px-4 py-2">
        <h1 id={heading} className="min-w-0 truncate text-base font-semibold">{title}</h1>
        <Button type="button" variant="ghost" aria-label="Закрыть документ" onClick={onClose}><X size={20} aria-hidden /></Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">{children}</div>
    </div>
  </dialog>;
}
