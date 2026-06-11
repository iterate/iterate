import { Suspense, lazy, type ComponentType } from "react";
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
    <Suspense fallback={null}>
      <LazyBlock {...props} />
    </Suspense>
  );
}
