import type { ComponentProps, ReactNode } from "react";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";

/**
 * The stream-first page layout: every domain object IS a stream (a secret
 * lives at /secrets/<name>, the secrets catalogue at /secrets, the project at
 * /), so every domain page is that stream's view. The stream takes the main
 * space; the domain's reduced-state render — creation saga, settings forms,
 * connection status — sits in an optional panel beside it (vertical split,
 * panel left / stream right; stacked with the panel on top on small screens).
 * Pages that are pure streams (agent chat, raw stream browser) pass no panel
 * and get the full width.
 */
export function StreamPage({
  panel,
  ...streamView
}: ComponentProps<typeof ProjectStreamView> & {
  panel?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
      {panel == null ? null : (
        <aside className="max-h-[45svh] min-h-0 shrink-0 overflow-y-auto border-b lg:max-h-none lg:w-[26rem] lg:border-b-0 lg:border-r">
          <div className="space-y-4 p-4">{panel}</div>
        </aside>
      )}
      <ProjectStreamView {...streamView} />
    </div>
  );
}
