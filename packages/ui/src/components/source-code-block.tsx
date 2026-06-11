import { Suspense, lazy, type ComponentType } from "react";
import type { SourceCodeBlockProps } from "./source-code-block.client.tsx";

export type {
  SourceCodeBlockExtension,
  SourceCodeBlockProps,
} from "./source-code-block.client.tsx";

// Keep CodeMirror (languages, theme, search) out of the server bundle: the
// worker script has a 10 MiB upload limit and the editor only mounts in the
// browser anyway. The type-only imports above leave no runtime edge.
const LazySourceCodeBlock: ComponentType<SourceCodeBlockProps> = import.meta.env.SSR
  ? () => null
  : lazy(async () => {
      const module = await import("./source-code-block.client.tsx");
      return { default: module.SourceCodeBlock };
    });

export function SourceCodeBlock(props: SourceCodeBlockProps) {
  return (
    <Suspense fallback={null}>
      <LazySourceCodeBlock {...props} />
    </Suspense>
  );
}
