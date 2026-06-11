import { Suspense, lazy, type ComponentProps, type ComponentType } from "react";

type ProjectStreamViewComponent = typeof import("./project-stream-view.tsx").ProjectStreamView;
type ProjectStreamViewProps = ComponentProps<ProjectStreamViewComponent>;

// Keep the stream view (CodeMirror, ai-elements feed, streams browser runtime)
// out of the server bundle: the worker script has a 10 MiB upload limit and
// the stream routes are ssr:false, so the server never renders it anyway.
const LazyProjectStreamView: ComponentType<ProjectStreamViewProps> = import.meta.env.SSR
  ? () => null
  : lazy(async () => {
      const module = await import("./project-stream-view.tsx");
      return { default: module.ProjectStreamView };
    });

export function ProjectStreamView(props: ProjectStreamViewProps) {
  return (
    <Suspense
      fallback={
        <div className="grid min-h-0 flex-1 place-items-center p-6 text-sm text-muted-foreground">
          Loading stream view
        </div>
      }
    >
      <LazyProjectStreamView {...props} />
    </Suspense>
  );
}
