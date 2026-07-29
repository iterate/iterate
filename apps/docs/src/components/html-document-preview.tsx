import { useMemo } from "react";
import { parseAnnotatedMarkdown } from "iterate/annotated-markdown";

export function HtmlDocumentPreview({ source }: { source: string }) {
  const parsed = useMemo(() => parseAnnotatedMarkdown(source), [source]);
  const body = parsed.kind === "structured" ? parsed.body : source;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className="docs-html-preview mx-auto w-full max-w-4xl px-8 py-8"
        // eslint-disable-next-line react-doctor/dangerous-html-sink -- Workspace HTML is intentionally trusted and rendered directly in Docs.
        dangerouslySetInnerHTML={{ __html: body }}
      />
    </div>
  );
}
