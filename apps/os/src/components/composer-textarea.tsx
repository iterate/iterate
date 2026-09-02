import { Suspense, lazy, type ComponentType } from "react";
import type { ComposerTextareaProps } from "./composer-textarea.client.tsx";

// CodeMirror is browser-only and large enough to matter to the Worker upload.
// Keep it behind the same lazy boundary as the shared CodeEditor component.
const LazyComposerTextarea: ComponentType<ComposerTextareaProps> = import.meta.env.SSR
  ? () => null
  : lazy(async () => {
      const module = await import("./composer-textarea.client.tsx");
      return { default: module.ComposerTextareaClient };
    });

export function ComposerTextarea(props: ComposerTextareaProps) {
  return (
    <Suspense fallback={null}>
      <LazyComposerTextarea {...props} />
    </Suspense>
  );
}
