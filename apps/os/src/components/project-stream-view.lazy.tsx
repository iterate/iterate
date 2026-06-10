import { Suspense, lazy, type ComponentProps } from "react";

type ProjectStreamViewComponent = typeof import("./project-stream-view.tsx").ProjectStreamView;

// Keep the stream view (CodeMirror, ai-elements feed, streams browser runtime)
// out of the server bundle: the worker script has a 10 MiB upload limit and
// the stream routes are ssr:false, so the server never renders it anyway.
const LazyProjectStreamView = lazy(async () => {
  if (import.meta.env.SSR) {
    return { default: (() => null) as unknown as ProjectStreamViewComponent };
  }
  const module = await import("./project-stream-view.tsx");
  return { default: module.ProjectStreamView };
});

export function ProjectStreamView(props: ComponentProps<ProjectStreamViewComponent>) {
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
