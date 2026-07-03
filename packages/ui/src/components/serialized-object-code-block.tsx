import { Suspense, lazy, type ComponentType } from "react";
import { cn } from "../lib/utils.ts";
import { Spinner } from "./spinner.tsx";
import type { SerializedObjectCodeBlockProps } from "./serialized-object-code-block.client.tsx";

export type { SerializedObjectCodeBlockProps } from "./serialized-object-code-block.client.tsx";

// Keep CodeMirror (languages, theme, search) out of the server bundle: the
// worker script has a 10 MiB upload limit and the editor only mounts in the
// browser anyway. The type-only imports above leave no runtime edge.
const LazyBlock: ComponentType<SerializedObjectCodeBlockProps> = import.meta.env.SSR
  ? () => null
  : lazy(async () => {
      const module = await import("./serialized-object-code-block.client.tsx");
      return { default: module.SerializedObjectCodeBlock };
    });

export function SerializedObjectCodeBlock(props: SerializedObjectCodeBlockProps) {
  return (
    <Suspense fallback={<SerializedObjectCodeBlockFallback {...props} />}>
      <LazyBlock {...props} />
    </Suspense>
  );
}

function SerializedObjectCodeBlockFallback({
  className,
  plainChrome = false,
}: Pick<SerializedObjectCodeBlockProps, "className" | "plainChrome">) {
  return (
    <div className={cn("relative flex min-h-0 flex-col", className)} data-spinner="true">
      <div
        className={cn(
          "flex min-h-16 items-center gap-2 px-3 py-2 text-xs text-muted-foreground",
          plainChrome ? "" : "rounded border",
        )}
      >
        <Spinner className="size-3.5" />
        <span>Loading code block...</span>
      </div>
    </div>
  );
}
