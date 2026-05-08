import { ExternalLink } from "lucide-react";
import type { StreamPath } from "@iterate-com/shared/streams/types";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { cn } from "@iterate-com/ui/lib/utils";
import { eventsStreamViewerUrl } from "~/lib/events-links.ts";

export function EventsDebugLink({
  className,
  label = "Open in Events",
  namespace,
  streamPath,
}: {
  className?: string;
  label?: string;
  namespace: string;
  streamPath: StreamPath;
}) {
  return (
    <a
      className={cn(buttonVariants({ variant: "outline", size: "sm" }), className)}
      href={eventsStreamViewerUrl({
        currentOrigin: currentOrigin(),
        namespace,
        streamPath,
      })}
      target="_blank"
      rel="noreferrer"
    >
      <ExternalLink data-icon="inline-start" />
      {label}
    </a>
  );
}

function currentOrigin() {
  return typeof window === "undefined" ? undefined : window.location.origin;
}
