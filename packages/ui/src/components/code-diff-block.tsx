import { Suspense, lazy, type ComponentProps, type ComponentType } from "react";

type CodeDiffBlockProps = ComponentProps<
  typeof import("./code-diff-block.client.tsx").CodeDiffBlock
>;

// Keep CodeMirror's merge view out of the server bundle, same as
// source-code-block: the diff only mounts in the browser.
const LazyCodeDiffBlock: ComponentType<CodeDiffBlockProps> = import.meta.env.SSR
  ? () => null
  : lazy(async () => {
      const module = await import("./code-diff-block.client.tsx");
      return { default: module.CodeDiffBlock };
    });

export function CodeDiffBlock(props: CodeDiffBlockProps) {
  return (
    <Suspense fallback={null}>
      <LazyCodeDiffBlock {...props} />
    </Suspense>
  );
}
