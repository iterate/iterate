// React viewer for annotated-markdown bodies: a source-stamped renderer, the
// DOM↔source projection built from its stamps, and CSS-Highlight painting.
// The codec itself (parse/edits/anchors) is the sibling `annotated-markdown`
// entry; this entry adds only presentation machinery.

export { AnnotatedMarkdownView } from "./render.tsx";
export { buildProjection, sourceOffsetAtPoint } from "./projection.ts";
export type { SourceProjection } from "./projection.ts";
export { canPaintHighlights, clearHighlights, paintHighlights } from "./highlights.ts";
