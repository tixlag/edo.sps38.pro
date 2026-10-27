import type { ReactNode } from "react";
import { lkEmployeeUrl } from "../lib/review-groups";

/**
 * Link to the public LK employee card by 1C code; plain text when the code
 * is missing (no URL can be built).
 */
export function LkLink({
  code1c,
  children,
}: {
  code1c: string | null | undefined;
  children: ReactNode;
}) {
  const url = lkEmployeeUrl(code1c);
  if (!url) return <span>{children}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`Профиль в ЛК: ${code1c}`}
      className="text-[var(--primary)] underline-offset-4 hover:underline"
    >
      {children}
    </a>
  );
}
