import type { ComponentProps, ReactNode } from "react";
import type { StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import {
  StreamTreeBrowser,
  type StreamTreeBrowserSource,
} from "~/components/stream-tree-browser.tsx";

type ProjectStreamViewProps = ComponentProps<typeof ProjectStreamView>;

export function StreamExplorerTreePage({
  currentPath,
  header,
  onOpenPath,
  source,
}: {
  currentPath?: StreamPathType;
  header?: ReactNode;
  onOpenPath: (streamPath: StreamPathType) => void;
  source: StreamTreeBrowserSource;
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      {header == null ? null : <div className="min-w-0">{header}</div>}
      <StreamTreeBrowser source={source} currentPath={currentPath} onOpenPath={onOpenPath} />
    </section>
  );
}

export function StreamExplorerDetail({
  currentPath,
  onOpenPath,
  source,
  streamView,
}: {
  currentPath: StreamPathType;
  onOpenPath: (streamPath: StreamPathType) => void;
  source: StreamTreeBrowserSource;
  streamView: Omit<ProjectStreamViewProps, "streamPath">;
}) {
  return (
    <section className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[20rem_minmax(0,1fr)]">
      <aside className="hidden min-h-0 border-r p-3 lg:flex">
        <StreamTreeBrowser source={source} currentPath={currentPath} onOpenPath={onOpenPath} />
      </aside>
      <ProjectStreamView {...streamView} streamPath={currentPath} />
    </section>
  );
}
