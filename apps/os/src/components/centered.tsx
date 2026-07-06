import type { ReactNode } from "react";

/** Muted, centered placeholder for empty/pending/error fills in stream panes. */
export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-6 text-sm text-muted-foreground">
      {children}
    </div>
  );
}
