import { ExternalLink } from "lucide-react";
import { cn } from "@iterate-com/ui/lib/utils";
import { getEventTypePageByType } from "~/lib/event-type-pages.ts";

export function EventType({ type, className }: { type: string; className?: string }) {
  const page = getEventTypePageByType(type);

  if (!page) {
    return <span className={cn("font-mono", className)}>{type}</span>;
  }

  return (
    <a
      href={page.href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex max-w-full items-center gap-1 font-mono text-primary hover:underline",
        className,
      )}
    >
      <span className="truncate">{type}</span>
      <ExternalLink className="size-3 shrink-0" />
    </a>
  );
}
