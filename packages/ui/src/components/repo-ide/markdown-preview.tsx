import { Suspense, lazy, type ComponentType } from "react";
import type { StreamdownProps } from "streamdown";

/** The repo's markdown, rendered. Repo content is whatever its authors and agents committed, so
 *  nothing in it runs: raw HTML is neither parsed nor shown, images are not fetched, and only
 *  http(s) links stay links. */
const Markdown: ComponentType<StreamdownProps> = lazy(async () => {
  const { Streamdown } = await import("streamdown");
  function SafeMarkdown(props: StreamdownProps) {
    return (
      <Streamdown
        mode="static"
        controls={false}
        linkSafety={{ enabled: false }}
        rehypePlugins={[]}
        skipHtml
        disallowedElements={["img"]}
        urlTransform={(url) => (/^https?:\/\//i.test(url) ? url : "")}
        {...props}
      />
    );
  }
  return { default: SafeMarkdown };
});

export function MarkdownPreview({ markdown }: { markdown: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-8 py-6 text-sm">
        <Suspense
          fallback={
            <div className="text-sm text-muted-foreground" data-spinner="true" role="status">
              Rendering preview…
            </div>
          }
        >
          <Markdown>{markdown}</Markdown>
        </Suspense>
      </div>
    </div>
  );
}
