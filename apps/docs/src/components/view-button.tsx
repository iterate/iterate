import type { ReactNode } from "react";

export function ViewButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
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
