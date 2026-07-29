import { parseAnnotatedMarkdown } from "iterate/annotated-markdown";

const ENVELOPE_OPEN = '<script type="application/json" data-iterate-annotations="v1">';
const ENVELOPE_CLOSE = "</script>";

/**
 * Returns the annotated-document source consumed by the shared comments UI.
 * HTML keeps its discussion store in a non-rendering JSON script element so
 * opening the workspace file in any ordinary browser never paints Markdown
 * discussion headings after the document.
 */
export function annotationsSourceForHtmlDocument(source: string): string {
  const open = source.lastIndexOf(ENVELOPE_OPEN);
  if (open === -1) return source;

  const beforeOpen = source.slice(0, open);
  const afterOpen = source.slice(open + ENVELOPE_OPEN.length);
  const close = afterOpen.indexOf(ENVELOPE_CLOSE);
  if (close === -1 || afterOpen.slice(close + ENVELOPE_CLOSE.length).trim() !== "") return source;

  const encoded = afterOpen.slice(0, close).trim();
  try {
    const annotations: unknown = JSON.parse(encoded);
    return typeof annotations === "string" ? beforeOpen + annotations : source;
  } catch {
    return source;
  }
}

/**
 * Applies an annotated-Markdown mutation to an HTML document, then stores the
 * resulting discussion as inert JSON while leaving the HTML body byte-for-byte
 * unchanged. Escaping `<` prevents a comment containing `</script>` from
 * terminating the envelope in an HTML parser.
 */
export function transformHtmlDocumentAnnotations(
  source: string,
  transform: (annotatedSource: string) => string,
): string {
  const next = transform(annotationsSourceForHtmlDocument(source));
  const parsed = parseAnnotatedMarkdown(next);
  if (parsed.kind !== "structured" || parsed.discussion === null) return next;

  const body = next.slice(0, parsed.discussion.range.start);
  const annotations = next.slice(parsed.discussion.range.start);
  const encoded = JSON.stringify(annotations).replaceAll("<", "\\u003c");
  return `${body}${ENVELOPE_OPEN}\n${encoded}\n${ENVELOPE_CLOSE}\n`;
}
