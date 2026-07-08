import { cn } from "@iterate-com/ui/lib/utils";
import { openGlobalCommandPalette } from "~/components/global-command-palette-events.ts";

export function StreamPathPill({
  className,
  streamPath,
  title = `${streamPath} — click or ⌘K to switch streams`,
}: {
  className?: string;
  streamPath: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      title={title}
      onClick={() => openGlobalCommandPalette()}
      className={cn(
        "flex h-9 min-w-0 cursor-pointer items-center gap-2 rounded-full bg-muted px-3.5 hover:bg-muted/70",
        className,
      )}
    >
      <span className="truncate font-mono text-sm">{streamPath}</span>
      <kbd className="hidden shrink-0 rounded bg-background px-1.5 py-px text-[10px] text-muted-foreground sm:inline">
        ⌘K
      </kbd>
    </button>
  );
}
