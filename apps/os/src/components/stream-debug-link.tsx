import { ExternalLink } from "lucide-react";
import type { StreamPath } from "@iterate-com/shared/streams/types";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { cn } from "@iterate-com/ui/lib/utils";
import { buildProjectStreamViewerUrl } from "~/lib/stream-viewer-url.ts";

export function StreamDebugLink({
  className,
  label = "Open stream",
  projectSlug,
  streamPath,
}: {
  className?: string;
  label?: string;
  projectSlug: string;
  streamPath: StreamPath;
}) {
  return (
    <a
      className={cn(buttonVariants({ variant: "outline", size: "sm" }), className)}
      href={buildProjectStreamViewerUrl({
        baseUrl: currentOrigin(),
        projectSlug,
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
