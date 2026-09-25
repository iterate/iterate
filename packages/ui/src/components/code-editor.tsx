import { Suspense, lazy, type ComponentType } from "react";
import type { CodeEditorProps } from "./code-editor.client.tsx";

export type { CodeEditorProps } from "./code-editor.client.tsx";

// Keeps CodeMirror out of the server bundle, as code-block.tsx explains.
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
