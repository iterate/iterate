const ENVELOPE_OPEN = '<script type="application/json" data-roughdraft="v1">';
const ENVELOPE_CLOSE = "</script>";

/**
 * Returns the RFM review payload for an HTML document. HTML has no Markdown
 * body to annotate, so comments live in a non-rendering JSON script element.
 */
export function annotationsSourceForHtmlDocument(source: string): string {
  return parseHtmlReviewEnvelope(source).payload ?? "";
}

function parseHtmlReviewEnvelope(source: string): { body: string; payload: string | null } {
  const open = source.lastIndexOf(ENVELOPE_OPEN);
  if (open === -1) return { body: source, payload: null };

  const afterOpen = source.slice(open + ENVELOPE_OPEN.length);
  const close = afterOpen.indexOf(ENVELOPE_CLOSE);
  if (close === -1)
    throw new Error("Invalid Roughdraft review envelope: missing closing script tag.");
  if (afterOpen.slice(close + ENVELOPE_CLOSE.length).trim() !== "") {
    throw new Error("Invalid Roughdraft review envelope: it must be the final document content.");
  }
  const encoded = afterOpen.slice(0, close).trim();
  let payload: unknown;
  try {
    payload = JSON.parse(encoded);
  } catch {
    throw new Error("Invalid Roughdraft review envelope: payload is not valid JSON.");
  }
  if (typeof payload !== "string") {
    throw new Error("Invalid Roughdraft review envelope: payload must be a JSON string.");
  }
  return { body: source.slice(0, open), payload };
}

/**
 * Applies an RFM-only mutation and stores the result as inert JSON while
 * leaving the HTML body byte-for-byte unchanged.
 */
export function transformHtmlDocumentAnnotations(
  source: string,
  transform: (annotatedSource: string) => string,
): string {
  const envelope = parseHtmlReviewEnvelope(source);
  const payload = envelope.payload ?? "";
  const next = transform(payload);
  if (next === payload) return source;

  if (next === "") return envelope.body;
  const encoded = JSON.stringify(next).replaceAll("<", "\\u003c");
  return `${envelope.body}${ENVELOPE_OPEN}\n${encoded}\n${ENVELOPE_CLOSE}\n`;
}
