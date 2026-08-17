import type { ReactNode } from "react";

export function ViewButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  /** Accessible name — the buttons are icon-only, the tooltip is decoration. */
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={
        active
          ? "flex h-7 items-center gap-1 rounded-md bg-background px-2 text-xs font-medium shadow-sm"
          : "flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground"
      }
    >
      {children}
    </button>
  );
}
