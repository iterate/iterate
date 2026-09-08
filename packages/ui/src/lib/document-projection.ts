export const SOURCE_START_ATTRIBUTE = "data-document-source-start";
export const SOURCE_END_ATTRIBUTE = "data-document-source-end";
export const SOURCE_ATOMIC_ATTRIBUTE = "data-document-source-atomic";
export const BLOCK_START_ATTRIBUTE = "data-document-block-start";

export interface SourceRange {
  start: number;
  end: number;
}

export interface DomRangeEndpoints {
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
}

export interface DocumentProjection {
  domPointToSource(node: Node, offset: number, affinity: "start" | "end"): number | null;
  domRangeToSource(range: DomRangeEndpoints): SourceRange | null;
  sourceRangeToDomRanges(range: SourceRange): Range[];
  sourceOffsetAtPoint(documentRef: Document, x: number, y: number): number | null;
}

interface Segment {
  text: Text;
  start: number;
  end: number;
  atomic: boolean;
}

interface CaretPositionLike {
  offsetNode: Node;
  offset: number;
}

/**
 * Creates an exact body-source ↔ rendered-DOM mapping from attributes emitted
 * by MarkdownDocumentRenderer. Source offsets are UTF-16 offsets into the
 * exact Markdown string given to that renderer; annotations must use the same
 * convention. Atomic runs (entities and escapes) snap to an honest edge.
 */
export function buildDocumentProjection(root: HTMLElement): DocumentProjection {
  const segments: Segment[] = [];
  for (const element of root.querySelectorAll<HTMLElement>(`[${SOURCE_START_ATTRIBUTE}]`)) {
    const start = Number(element.getAttribute(SOURCE_START_ATTRIBUTE));
    const end = Number(element.getAttribute(SOURCE_END_ATTRIBUTE));
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;

    let cursor = start;
    const atomic = element.hasAttribute(SOURCE_ATOMIC_ATTRIBUTE);
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      // SHOW_TEXT guarantees this node is Text; TypeScript exposes Node.
      const text = node as Text;
      if (atomic) {
        segments.push({ text, start, end, atomic: true });
        continue;
      }
      const next = Math.min(end, cursor + text.data.length);
      segments.push({ text, start: cursor, end: next, atomic: false });
      cursor = next;
    }
  }

  const segmentForText = (node: Node) =>
    node.nodeType === Node.TEXT_NODE
      ? segments.find((segment) => segment.text === node)
      : undefined;

  const firstSegmentWithin = (node: Node): Segment | null => {
    if (node.nodeType === Node.TEXT_NODE) return segmentForText(node) ?? null;
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    return segments.find((segment) => node.contains(segment.text)) ?? null;
  };

  const lastSegmentWithin = (node: Node): Segment | null => {
    if (node.nodeType === Node.TEXT_NODE) return segmentForText(node) ?? null;
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    return [...segments].reverse().find((segment) => node.contains(segment.text)) ?? null;
  };

  const elementPointToSource = (node: Node | null, affinity: "start" | "end") => {
    if (!(node instanceof Element)) return null;
    const block =
      node.closest(`[${BLOCK_START_ATTRIBUTE}]`) ?? node.closest("[data-document-renderer]");
    if (block === null) return null;
    const segment = affinity === "start" ? firstSegmentWithin(block) : lastSegmentWithin(block);
    if (segment === null) return null;
    return affinity === "start" ? segment.start : segment.end;
  };

  const domPointToSource = (
    node: Node,
    offset: number,
    affinity: "start" | "end",
  ): number | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      const segment = segmentForText(node);
      if (segment === undefined) return elementPointToSource(node.parentNode, affinity);
      if (!segment.atomic) return segment.start + Math.min(offset, segment.end - segment.start);
      if (offset <= 0) return segment.start;
      if (offset >= segment.text.data.length) return segment.end;
      return affinity === "start" ? segment.start : segment.end;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    // A selection can end at offset zero of the next span. Use the previous
    // text edge so neither that span nor its Markdown prefix is included.
    if (offset === 0 && affinity === "end") {
      const first = firstSegmentWithin(node);
      if (first !== null) return segments[segments.indexOf(first) - 1]?.end ?? first.start;
    }

    const children = Array.from(node.childNodes);
    if (affinity === "start") {
      for (const child of children.slice(offset)) {
        const segment = firstSegmentWithin(child);
        if (segment !== null) return segment.start;
      }
    } else {
      for (const child of children.slice(0, offset).reverse()) {
        const segment = lastSegmentWithin(child);
        if (segment !== null) return segment.end;
      }
    }
    return elementPointToSource(node, affinity);
  };

  return {
    domPointToSource,
    domRangeToSource(range) {
      const start = domPointToSource(range.startContainer, range.startOffset, "start");
      const end = domPointToSource(range.endContainer, range.endOffset, "end");
      if (start === null || end === null || end <= start) return null;
      return { start, end };
    },

    sourceRangeToDomRanges(range) {
      const ranges: Range[] = [];
      for (const segment of segments) {
        const start = Math.max(range.start, segment.start);
        const end = Math.min(range.end, segment.end);
        if (end <= start) continue;
        const domRange = root.ownerDocument.createRange();
        if (segment.atomic) domRange.selectNodeContents(segment.text);
        else {
          domRange.setStart(segment.text, start - segment.start);
          domRange.setEnd(segment.text, end - segment.start);
        }
        ranges.push(domRange);
      }
      return ranges;
    },

    sourceOffsetAtPoint(documentRef, x, y) {
      // These optional browser APIs are missing from TypeScript's DOM types.
      // The cast models only the runtime-probed optional members.
      const caretDocument = documentRef as Document & {
        caretPositionFromPoint?: (x: number, y: number) => CaretPositionLike | null;
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      const position = caretDocument.caretPositionFromPoint?.(x, y);
      if (position !== null && position !== undefined) {
        return domPointToSource(position.offsetNode, position.offset, "start");
      }
      const range = caretDocument.caretRangeFromPoint?.(x, y);
      if (range === null || range === undefined) return null;
      return domPointToSource(range.startContainer, range.startOffset, "start");
    },
  };
}

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
  keys(): IterableIterator<string>;
}

interface HighlightApi {
  registry: HighlightRegistry;
  Highlight: new (...ranges: Range[]) => unknown;
}

function highlightApi(): HighlightApi | null {
  // CSS.highlights and Highlight are browser APIs omitted by TypeScript's DOM
  // types. These casts add optional members and are immediately runtime-probed.
  const css = globalThis.CSS as (typeof CSS & { highlights?: HighlightRegistry }) | undefined;
  const Highlight = (globalThis as { Highlight?: HighlightApi["Highlight"] }).Highlight;
  if (css?.highlights === undefined || Highlight === undefined) return null;
  return { registry: css.highlights, Highlight };
}

export function paintDocumentHighlights(
  prefix: string,
  groups: Array<{ key: string; ranges: Range[] }>,
): void {
  const api = highlightApi();
  if (api === null) return;
  clearDocumentHighlights(prefix);
  for (const group of groups) {
    if (group.ranges.length > 0)
      api.registry.set(`${prefix}-${group.key}`, new api.Highlight(...group.ranges));
  }
}

export function clearDocumentHighlights(prefix: string): void {
  const api = highlightApi();
  if (api === null) return;
  for (const name of [...api.registry.keys()]) {
    if (name.startsWith(`${prefix}-`)) api.registry.delete(name);
  }
}
