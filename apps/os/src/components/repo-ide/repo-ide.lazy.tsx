import { Suspense, lazy, type ComponentProps, type ComponentType } from "react";

type RepoIdeProps = ComponentProps<typeof import("./repo-ide.tsx").RepoIde>;

// Keep the IDE (pierre trees, CodeMirror + languages, merge view) out of the
// server bundle, same as project-stream-view.lazy: the worker script has a
// 10 MiB upload limit and the repo routes are ssr:false anyway.
const LazyRepoIde: ComponentType<RepoIdeProps> = import.meta.env.SSR
  ? () => null
  : lazy(async () => {
      const module = await import("./repo-ide.tsx");
      return { default: module.RepoIde };
    });

export function RepoIde(props: RepoIdeProps) {
  return (
    <Suspense
      fallback={
        <div
          className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
          data-spinner="true"
        >
          Loading repo files…
        </div>
      }
    >
      <LazyRepoIde {...props} />
    </Suspense>
  );
}
