import type { ReactNode } from "react";

export function CenterCenter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className={className}>{children}</div>
    </div>
  );
}
