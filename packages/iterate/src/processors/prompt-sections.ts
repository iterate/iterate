// The append-time authoring parser for sectionized prompt files (design:
// tasks/prompt-sections-tree.md, decision 3): authors write ONE file with
// `<section id="...">` tags; the APPENDING code parses it once into segments,
// and fold operations only ever address segments by id — they never parse
// model-visible strings. Shared between the platform (agent birth defaults)
// and config-repo template workers, which is why it lives in the iterate
// package rather than apps/os.

export type PromptSegment = { sectionId: string; content: string };

const SECTION_OPEN_TAG = /<section id="([^"<>]+)">/g;

/**
 * Parse a prompt file's authoring syntax into segments, in file order. Content
 * inside `<section id="x">...</section>` becomes a segment with that id;
 * content outside any tag (including a whole untagged file) becomes a segment
 * with `fallbackSectionId` — so an untagged prompt file parses to one segment
 * and keeps working unchanged. Throws on malformed authoring (unclosed or
 * nested tags): this runs at append time, where a loud failure beats silently
 * shipping tag soup to a model.
 */
export function parsePromptSections(input: {
  content: string;
  fallbackSectionId: string;
}): PromptSegment[] {
  const segments: PromptSegment[] = [];
  const pushFallback = (raw: string) => {
    const content = raw.trim();
    if (content !== "") segments.push({ sectionId: input.fallbackSectionId, content });
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
      throw new Error(`unclosed <section id="${open[1]}"> in prompt file`);
    }
    const body = input.content.slice(bodyStart, close);
    if (body.includes("<section ")) {
      throw new Error(`nested <section> inside <section id="${open[1]}"> — sections are flat`);
    }
    segments.push({ sectionId: open[1]!, content: body.trim() });
    cursor = close + "</section>".length;
    SECTION_OPEN_TAG.lastIndex = cursor;
  }
  pushFallback(input.content.slice(cursor));
  if (segments.length === 0) {
    // An empty (or whitespace-only) file still parses: one empty fallback
    // segment, so a keyed supersession with empty content stays expressible.
    segments.push({ sectionId: input.fallbackSectionId, content: "" });
  }
  return segments;
}
