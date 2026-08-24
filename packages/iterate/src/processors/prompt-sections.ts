// The append-time authoring parser for sectionized prompt files (design:
// tasks/prompt-sections-tree.md and docs/prompt-sections-demo.html): authors
// write ONE file with `<section key="...">` tags; the APPENDING code parses
// it once into segments, and every later change addresses a section by
// re-adding its key — nothing ever parses model-visible strings again. The
// tags are the SAME syntax the fold renders the standing document with, so
// an unforked file round-trips byte-identically. Shared between the platform
// (agent birth defaults) and config-repo template workers, which is why it
// lives in the iterate package rather than apps/os.

export type PromptSegment = { key: string; content: string };

const SECTION_OPEN_TAG = /<section key="([^"<>]+)">/g;

/**
 * Parse a prompt file's authoring syntax into segments, in file order.
 * Content inside `<section key="x">...</section>` becomes a segment with
 * that key; content outside any tag (including a whole untagged file)
 * becomes a segment with `fallbackKey` — so an untagged prompt file parses
 * to one segment and keeps working unchanged. Throws on malformed authoring
 * (unclosed or nested tags): this runs at append time, where a loud failure
 * beats silently shipping tag soup to a model.
 */
export function parsePromptSections(input: {
  content: string;
  fallbackKey: string;
}): PromptSegment[] {
  const segments: PromptSegment[] = [];
  const pushFallback = (raw: string) => {
    const content = raw.trim();
    if (content !== "") segments.push({ key: input.fallbackKey, content });
  };
  let cursor = 0;
  SECTION_OPEN_TAG.lastIndex = 0;
  for (;;) {
    const open = SECTION_OPEN_TAG.exec(input.content);
    if (open === null) break;
    pushFallback(input.content.slice(cursor, open.index));
    const bodyStart = open.index + open[0].length;
    const close = input.content.indexOf("</section>", bodyStart);
    if (close < 0) {
      throw new Error(`unclosed <section key="${open[1]}"> in prompt file`);
    }
    const body = input.content.slice(bodyStart, close);
    if (body.includes("<section ")) {
      throw new Error(`nested <section> inside <section key="${open[1]}"> — sections are flat`);
    }
    segments.push({ key: open[1]!, content: body.trim() });
    cursor = close + "</section>".length;
    SECTION_OPEN_TAG.lastIndex = cursor;
  }
  pushFallback(input.content.slice(cursor));
  if (segments.length === 0) {
    // An empty (or whitespace-only) file still parses: one empty fallback
    // segment, so a keyed supersession with empty content stays expressible.
    segments.push({ key: input.fallbackKey, content: "" });
  }
  return segments;
}
