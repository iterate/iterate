import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { StreamPath } from "~/lib/stream-links.ts";

/**
 * The stream face of a domain page. Every domain object IS a stream (a secret
 * lives at /secrets/<name>, the secrets catalogue at /secrets, the project at
 * /), so every domain page shows both views: its reduced-state render as the
 * primary content, and this section — that object's event stream — as the
 * secondary one. Collapsed by default and only mounted once opened (the
 * stream view hosts a browser-side SQLite mirror).
 */
export function StreamViewSection({
  emptyLabel = "No events in this stream yet.",
  label,
  projectId,
  streamPath,
}: {
  emptyLabel?: string;
  /** Short human name for the stream, e.g. "project root" or the path itself. */
  label?: string;
  projectId: string;
  streamPath: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section className="flex min-h-0 flex-col rounded-lg border" data-testid="stream-view-section">
      <Button
        type="button"
        variant="ghost"
        className="justify-start gap-2 px-4 py-3 text-sm font-semibold"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <ChevronDownIcon aria-hidden="true" data-icon="icon" />
        ) : (
          <ChevronRightIcon aria-hidden="true" data-icon="icon" />
        )}
        Event stream
        <span className="font-mono font-normal text-muted-foreground">{label ?? streamPath}</span>
      </Button>
      {open ? (
        <div className="flex h-[32rem] min-h-0 flex-col border-t">
          <ProjectStreamView
            emptyLabel={emptyLabel}
            projectId={projectId}
            streamPath={StreamPath.parse(streamPath)}
          />
        </div>
      ) : null}
    </section>
  );
}
