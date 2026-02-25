import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./lib/utils.ts";

export function SelectableList(props: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("max-h-[60vh] space-y-2 overflow-auto pr-1", props.className)}>
      {props.children}
    </div>
  );
}

export function SelectableListItem(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    selected?: boolean;
  },
) {
  const { selected = false, className, ...rest } = props;
  return (
    <button
      {...rest}
      className={cn(
        "w-full rounded-md border px-3 py-2 text-left text-xs",
        selected
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent hover:text-accent-foreground",
        className,
      )}
    />
  );
}

export function EmptyState(props: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{props.children}</p>;
}

export function MetaBlock(props: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-2 rounded-lg border bg-muted p-3 text-xs", props.className)}>
      {props.children}
    </div>
  );
}
