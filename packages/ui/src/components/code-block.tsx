import { Suspense, lazy, type ComponentType } from "react";
import { cn } from "cn";
import { Spinner } from "./spinner.tsx";
import type { CodeBlockProps, SerializedObjectCodeBlockProps } from "./code-block.client.tsx";

// Keep CodeMirror (languages, theme, search) out of the server bundle: the
// worker script has a 10 MiB upload limit and the editor only mounts in the
// browser anyway. The type-only imports leave no runtime edge.
const LazyCodeBlock = lazyClient((module) => module.CodeBlock);
const LazySerializedObjectCodeBlock = lazyClient((module) => module.SerializedObjectCodeBlock);

/** Read-only code with search, folding and a copy button (code-block.client.tsx). */
export function CodeBlock(props: CodeBlockProps) {
  return (
    <Suspense fallback={<CodeBlockFallback className={props.className} />}>
      <LazyCodeBlock {...props} />
    </Suspense>
  );
}

/** Any value as YAML or JSON, with a button to copy each (code-block.client.tsx). */
export function SerializedObjectCodeBlock(props: SerializedObjectCodeBlockProps) {
  return (
    <Suspense fallback={<CodeBlockFallback className={props.className} />}>
      <LazySerializedObjectCodeBlock {...props} />
    </Suspense>
  );
}

function CodeBlockFallback({ className }: { className?: string }) {
  return (
    <div className={cn("relative flex min-h-0 flex-col", className)} data-spinner="true">
      <div className="flex min-h-16 items-center gap-2 rounded border px-3 py-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        <span>Loading code block...</span>
      </div>
    </div>
  );
}

function lazyClient<Props>(
  pick: (module: typeof import("./code-block.client.tsx")) => ComponentType<Props>,
): ComponentType<Props> {
  return import.meta.env.SSR
    ? () => null
    : lazy(async () => ({ default: pick(await import("./code-block.client.tsx")) }));
}
