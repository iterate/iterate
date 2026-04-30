import type { ComponentProps } from "react";
import { cn } from "../lib/utils.ts";

export function IterateMark({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border border-border/60 bg-muted/60 text-[10px] font-normal not-italic leading-none text-muted-foreground",
        className,
      )}
      {...props}
    >
      𝑖
    </span>
  );
}
