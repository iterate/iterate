import { Suspense, lazy, type ComponentType } from "react";
import { cn } from "cn";
import { Spinner } from "./spinner.tsx";
import type { CodeBlockProps, SerializedObjectCodeBlockProps } from "./code-block.client.tsx";

// Keep CodeMirror (languages, theme, search) out of the server bundle: the
// worker script has a 10 MiB upload limit and the editor only mounts in the
// browser anyway. The type-only imports leave no runtime edge.
const LazyCodeBlock: ComponentType<SourceCodeBlockProps> = import.meta.env.SSR
  ? () => null
  : lazy(async () => {
      // The grammars load with CodeBlock alone: markdown brings html, css and javascript, which
      // serialized data's chunk (yaml, json) would otherwise carry to the dash's event inspector.
      const [{ CodeBlock }, { javascript }, { markdown }] = await Promise.all([
        import("./code-block.client.tsx"),
        import("@codemirror/lang-javascript"),
        import("@codemirror/lang-markdown"),
      ]);
      const languages = {
        typescript: javascript({ jsx: true, typescript: true }),
        markdown: markdown(),
      };
      return {
        default: ({ language, ...props }: SourceCodeBlockProps) => (
          <CodeBlock {...props} language={languages[language]} />
        ),
      };
    });
const LazySerializedBlock: ComponentType<SerializedObjectCodeBlockProps> = import.meta.env.SSR
  ? () => null
  : lazy(async () => ({
      default: (await import("./code-block.client.tsx")).SerializedObjectCodeBlock,
    }));

type SourceCodeBlockProps = Omit<CodeBlockProps, "language" | "toolbar"> & {
  language: "typescript" | "markdown";
};

/** Read-only code with search, folding and a copy button (code-block.client.tsx). */
export function CodeBlock(props: SourceCodeBlockProps) {
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
      <LazySerializedBlock {...props} />
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
