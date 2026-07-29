import {
  BLOCK_END_ATTR,
  BLOCK_START_ATTR,
  SEGMENT_ATOMIC_ATTR,
  SEGMENT_END_ATTR,
  SEGMENT_START_ATTR,
} from "./render.tsx";

// The rendered-DOM ↔ source bridge. Built by walking the stamps the renderer
// left on the live DOM — never by diffing textContent against the source.
// Identity segments map character-for-character; atomic segments (decoded
// entities, escapes, non-contiguous code) map as indivisible units whose
// interior snaps to their edges.

export interface SourceProjection {
  /** Map a DOM point to a body-relative source offset (null: outside). */
  domPointToSource(node: Node, offset: number, affinity: "start" | "end"): number | null;
  /** Map a body-relative source range to paintable DOM ranges. */
  sourceRangeToDomRanges(range: { start: number; end: number }): Range[];
  /** Map a DOM selection to its body-relative source range (null: outside). */
  domRangeToSource(range: {
    startContainer: Node;
    startOffset: number;
    endContainer: Node;
    endOffset: number;
  }): { start: number; end: number } | null;
  /** The nearest enclosing block's source range for a DOM node. */
  blockRangeOf(node: Node): { start: number; end: number } | null;
}

interface Segment {
  text: Text;
  sourceStart: number;
  sourceEnd: number;
  atomic: boolean;
}

export function buildProjection(root: HTMLElement): SourceProjection {
  const segments: Segment[] = [];
  for (const span of root.querySelectorAll<HTMLElement>(`[${SEGMENT_START_ATTR}]`)) {
    const start = Number(span.getAttribute(SEGMENT_START_ATTR));
    const end = Number(span.getAttribute(SEGMENT_END_ATTR));
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    const atomic = span.hasAttribute(SEGMENT_ATOMIC_ATTR);
    // The renderer emits exactly one text node per segment span; a re-render
    // may split it (React text updates), so walk all of them in order.
    let sourceCursor = start;
    const walker = span.ownerDocument.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node as Text;
      const length = text.data.length;
      if (atomic) {
        segments.push({ text, sourceStart: start, sourceEnd: end, atomic: true });
      } else {
        segments.push({
          text,
          sourceStart: sourceCursor,
          sourceEnd: Math.min(end, sourceCursor + length),
          atomic: false,
        });
        sourceCursor += length;
      }
    }
  }

  const segmentOf = (node: Node): Segment | undefined =>
    segments.find((segment) => segment.text === node);

  const pointToSource = (node: Node, offset: number, affinity: "start" | "end"): number | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      const segment = segmentOf(node);
      if (segment !== undefined) {
        if (segment.atomic) {
          // Interior offsets have no honest mapping; snap to the unit's edge.
          if (offset <= 0) return segment.sourceStart;
          if (offset >= segment.text.data.length) return segment.sourceEnd;
          return affinity === "start" ? segment.sourceStart : segment.sourceEnd;
        }
        return segment.sourceStart + Math.min(offset, segment.sourceEnd - segment.sourceStart);
      }
      // Un-stamped text (list bullets never produce these, but be safe):
      // resolve through its parent element below.
      return elementPointToSource(node.parentNode, affinity);
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      // The point sits between child nodes: resolve to the nearest stamped
      // neighbour in the chosen direction.
      const children = Array.from(node.childNodes);
      if (affinity === "start") {
        for (let i = offset; i < children.length; i++) {
          const child = children[i];
          if (child === undefined) break;
          const first = firstSegmentWithin(child);
          if (first !== null) return first.sourceStart;
        }
        return elementPointToSource(node, "start");
      }
      for (let i = offset - 1; i >= 0; i--) {
        const child = children[i];
        if (child === undefined) break;
        const last = lastSegmentWithin(child);
        if (last !== null) return last.sourceEnd;
      }
      return elementPointToSource(node, "end");
    }
    return null;
  };

  const firstSegmentWithin = (node: Node): Segment | null => {
    if (node.nodeType === Node.TEXT_NODE) return segmentOf(node) ?? null;
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    for (const segment of segments) {
      if (node.contains(segment.text)) return segment;
    }
    return null;
  };
  const lastSegmentWithin = (node: Node): Segment | null => {
    if (node.nodeType === Node.TEXT_NODE) return segmentOf(node) ?? null;
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    for (let i = segments.length - 1; i >= 0; i--) {
      const segment = segments[i];
      if (segment !== undefined && node.contains(segment.text)) return segment;
    }
    return null;
  };

  const elementPointToSource = (node: Node | null, affinity: "start" | "end"): number | null => {
    if (node === null || !(node instanceof Element)) return null;
    const scope =
      node.closest(`[${BLOCK_START_ATTR}]`) ?? node.closest("[data-annotated-markdown-root]");
    if (scope === null) return null;
    const segment = affinity === "start" ? firstSegmentWithin(scope) : lastSegmentWithin(scope);
    if (segment === null) return null;
    return affinity === "start" ? segment.sourceStart : segment.sourceEnd;
  };

  return {
    domPointToSource: pointToSource,

    domRangeToSource(range) {
      const start = pointToSource(range.startContainer, range.startOffset, "start");
      const end = pointToSource(range.endContainer, range.endOffset, "end");
      if (start === null || end === null || end <= start) return null;
      return { start, end };
    },

    sourceRangeToDomRanges(range) {
      const doc = root.ownerDocument;
      const ranges: Range[] = [];
      for (const segment of segments) {
        const overlapStart = Math.max(range.start, segment.sourceStart);
        const overlapEnd = Math.min(range.end, segment.sourceEnd);
        if (overlapEnd <= overlapStart) continue;
        const domRange = doc.createRange();
        if (segment.atomic) {
          domRange.selectNodeContents(segment.text);
        } else {
          domRange.setStart(segment.text, overlapStart - segment.sourceStart);
          domRange.setEnd(segment.text, overlapEnd - segment.sourceStart);
        }
        ranges.push(domRange);
      }
      return ranges;
    },

    blockRangeOf(node) {
      const element = node instanceof Element ? node : node.parentElement;
      const block = element?.closest(`[${BLOCK_START_ATTR}]`);
      if (block == null) return null;
      const start = Number(block.getAttribute(BLOCK_START_ATTR));
      const end = Number(block.getAttribute(BLOCK_END_ATTR));
      if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
      return { start, end };
    },
  };
}

interface CaretPositionLike {
  offsetNode: Node;
  offset: number;
}

/**
 * Source offset under a pointer event, for highlight hit-testing (CSS
 * highlights are paint, not elements — clicks resolve through the caret).
 */
export function sourceOffsetAtPoint(
  projection: SourceProjection,
  documentRef: Document,
  x: number,
  y: number,
): number | null {
  const caretDocument = documentRef as Document & {
    caretPositionFromPoint?: (x: number, y: number) => CaretPositionLike | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = caretDocument.caretPositionFromPoint?.(x, y);
  if (position != null) {
    return projection.domPointToSource(position.offsetNode, position.offset, "start");
  }
  const range = caretDocument.caretRangeFromPoint?.(x, y);
  if (range != null) {
    return projection.domPointToSource(range.startContainer, range.startOffset, "start");
  }
  return null;
}
