import type { ReactNode } from "react";
import { cn } from "./lib/utils.ts";

export type StatusTone = "neutral" | "error" | "success";

const toneClass: Record<StatusTone, string> = {
  neutral: "border-border bg-muted text-muted-foreground",
  error: "border-destructive/30 bg-destructive/10 text-destructive",
  success: "border-emerald-400/40 bg-emerald-500/10 text-emerald-700",
};

export function StatusBanner(props: {
  tone?: StatusTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        toneClass[props.tone ?? "neutral"],
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}
