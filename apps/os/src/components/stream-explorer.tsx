import type { ComponentProps, ReactNode } from "react";
import type { StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { StreamTreeBrowser, type StreamTreeSource } from "~/components/stream-tree-browser.tsx";

export function StreamExplorerTreePage({
  currentPath,
  header,
  onOpenPath,
  rootPath,
  source,
}: {
  currentPath?: StreamPathType;
  header?: ReactNode;
  onOpenPath: (streamPath: StreamPathType) => void;
  rootPath?: StreamPathType;
  source: StreamTreeSource;
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      {header == null ? null : <div className="min-w-0">{header}</div>}
      <StreamTreeBrowser
        source={source}
        currentPath={currentPath}
        onOpenPath={onOpenPath}
        rootPath={rootPath}
      />
    </section>
  );
}

/**
 * Stream detail page. Navigation lives in the ⌘K stream switcher behind the
 * header's path pill, not a tree sidebar — the source feeds the switcher's
 * lazy child loading.
 */
type ProjectStreamViewProps = ComponentProps<typeof ProjectStreamView>;

export function StreamExplorerDetail({
  currentPath,
  showCommandPaletteTrigger = false,
  streamView,
}: {
  currentPath: StreamPathType;
  onOpenPath?: (streamPath: StreamPathType) => void;
  showCommandPaletteTrigger?: boolean;
  source?: StreamTreeSource;
  streamView: Omit<ProjectStreamViewProps, "streamPath">;
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ProjectStreamView
        {...streamView}
        streamPath={currentPath}
        showCommandPaletteTrigger={showCommandPaletteTrigger}
      />
    </section>
  );
}
