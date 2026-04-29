import { getCoreEventTypeSlug } from "@iterate-com/events-contract";
import { ExternalLink } from "lucide-react";
import { IterateMark } from "@iterate-com/ui/components/iterate-mark";
import { cn } from "@iterate-com/ui/lib/utils";
import { getEventTypePageByType } from "~/lib/event-type-pages.ts";

export function CoreEventTypeLabel({ type, className }: { type: string; className?: string }) {
  const slug = getCoreEventTypeSlug(type);

  if (slug == null) {
    return <span className={cn("font-mono", className)}>{type}</span>;
  }

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 font-mono", className)}>
      <IterateMark aria-hidden />
      <span className="truncate">{`core/${slug}`}</span>
    </span>
  );
}

export function EventType({ type, className }: { type: string; className?: string }) {
  const page = getEventTypePageByType(type);

  if (!page) {
    return <CoreEventTypeLabel type={type} className={className} />;
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
      <CoreEventTypeLabel type={type} />
      <ExternalLink className="size-3 shrink-0" />
    </a>
  );
}
