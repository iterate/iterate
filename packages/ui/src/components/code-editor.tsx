import { Suspense, lazy, type ComponentType } from "react";
import type { CodeEditorProps } from "./code-editor.client.tsx";

export type { CodeEditorProps } from "./code-editor.client.tsx";

// Same rationale as serialized-object-code-block: keep CodeMirror out of the
// server bundle (10 MiB worker upload limit) — it only mounts in the browser.
const LazyEditor: ComponentType<CodeEditorProps> = import.meta.env.SSR
  ? () => null
  : lazy(async () => {
      const module = await import("./code-editor.client.tsx");
      return { default: module.CodeEditor };
    });

export function CodeEditor(props: CodeEditorProps) {
  return (
    <Suspense fallback={null}>
      <LazyEditor {...props} />
    </Suspense>
  );
}
