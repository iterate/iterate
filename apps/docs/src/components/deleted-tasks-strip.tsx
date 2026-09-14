import { Button } from "@iterate-com/ui/components/button";
import type { TaskChangeSummary } from "../state.ts";

/**
 * Deleted cards leave the board instantly, so this strip is where a pending
 * deletion stays visible — and reversible — until it is committed.
 */
export function DeletedTasksStrip({
  deletedChanges,
  onRestore,
}: {
  deletedChanges: readonly TaskChangeSummary[];
  onRestore: (path: string) => void;
}) {
  if (deletedChanges.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-b bg-background px-3 py-1">
      <span className="text-xs text-muted-foreground">Deleted</span>
      {deletedChanges.map((change) => (
        <span
          key={change.path}
          title={change.path}
          className="inline-flex flex-wrap items-center gap-1.5 rounded-full border py-0.5 pr-1 pl-2.5 text-xs text-muted-foreground"
        >
          <span className="size-1.5 rounded-full bg-red-500" aria-hidden />
          <span className="line-through">{change.title}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[11px] text-foreground"
            onClick={() => onRestore(change.path)}
            title={`Restore ${change.title}`}
          >
            restore
          </Button>
        </span>
      ))}
    </div>
  );
}
