// @vitest-environment jsdom
/** @jsxImportSource react */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { buildProjection } from "./projection.ts";
import { AnnotatedMarkdownView } from "./render.tsx";

// The projection contract: DOM selection → source → DOM must round-trip
// without wrong attachment across markdown constructs. Rendering here goes
// through static markup + innerHTML — the projection only reads data stamps
// off the live DOM, so the render path is irrelevant to what's under test.

function mount(source: string): { root: HTMLElement; body: string } {
  const html = renderToStaticMarkup(<AnnotatedMarkdownView source={source} />);
  const host = document.createElement("div");
  host.innerHTML = html;
  const root = host.firstElementChild as HTMLElement;
  return { root, body: source };
}

/** The DOM point at the nth occurrence of `needle` in rendered text. */
function domPointAt(
  root: HTMLElement,
  needle: string,
  occurrence = 0,
): { node: Text; offset: number } {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    let index = text.data.indexOf(needle);
    while (index !== -1) {
      if (seen === occurrence) return { node: text, offset: index };
      seen++;
      index = text.data.indexOf(needle, index + 1);
    }
  }
  throw new Error(`rendered text does not contain ${JSON.stringify(needle)}`);
}

describe("selection → source", () => {
  test("plain prose maps exactly", () => {
    const body = "Alpha beta gamma delta.\n";
    const { root } = mount(body);
    const projection = buildProjection(root);
    const start = domPointAt(root, "beta");
    const end = domPointAt(root, "gamma");
    const range = projection.domRangeToSource({
      startContainer: start.node,
      startOffset: start.offset,
      endContainer: end.node,
      endOffset: end.offset + "gamma".length,
    });
    expect(range).toEqual({ start: body.indexOf("beta"), end: body.indexOf("gamma") + 5 });
    expect(body.slice(range!.start, range!.end)).toBe("beta gamma");
  });

  test("a selection crossing emphasis spans the markup in source", () => {
    const body = "Plain **bold middle** after.\n";
    const { root } = mount(body);
    const projection = buildProjection(root);
    const start = domPointAt(root, "Plain");
    const end = domPointAt(root, "middle");
    const range = projection.domRangeToSource({
      startContainer: start.node,
      startOffset: 0,
      endContainer: end.node,
      endOffset: end.offset + "middle".length,
    });
    expect(body.slice(range!.start, range!.end)).toBe("Plain **bold middle");
  });

  test("inline code maps through its backticks", () => {
    const body = "Run `pnpm test` now.\n";
    const { root } = mount(body);
    const projection = buildProjection(root);
    const point = domPointAt(root, "pnpm test");
    const range = projection.domRangeToSource({
      startContainer: point.node,
      startOffset: point.offset,
      endContainer: point.node,
      endOffset: point.offset + "pnpm test".length,
    });
    expect(body.slice(range!.start, range!.end)).toBe("pnpm test");
  });

  test("a fence body echoing its info string maps to the body, not the fence", () => {
    const body = "Use this:\n\n```python\npython\n```\n\nDone.\n";
    const { root } = mount(body);
    const projection = buildProjection(root);
    const point = domPointAt(root, "python");
    const range = projection.domRangeToSource({
      startContainer: point.node,
      startOffset: point.offset,
      endContainer: point.node,
      endOffset: point.offset + "python".length,
    });
    // The BODY "python" sits on the line after the opening fence.
    expect(range).toEqual({
      start: body.indexOf("python\n```"),
      end: body.indexOf("python\n```") + "python".length,
    });
  });

  test("single-line indented code still maps its content", () => {
    const body = "Steps:\n\n    make deploy\n\nDone.\n";
    const { root } = mount(body);
    const projection = buildProjection(root);
    const point = domPointAt(root, "make deploy");
    const start = projection.domPointToSource(point.node, point.offset, "start");
    // Indented code has no fence line; the mapping may be exact or snap to
    // the block atomically, but it must land on the code, never elsewhere.
    expect(body.slice(start!, start! + 4)).toBe("make");
  });

  test("fenced code content maps to the inside of the fence", () => {
    const body = "Before.\n\n```ts\nconst x = 1;\n```\n\nAfter.\n";
    const { root } = mount(body);
    const projection = buildProjection(root);
    const point = domPointAt(root, "const x");
    const range = projection.domRangeToSource({
      startContainer: point.node,
      startOffset: point.offset,
      endContainer: point.node,
      endOffset: point.offset + "const x".length,
    });
    expect(body.slice(range!.start, range!.end)).toBe("const x");
  });

  test("entity-decoded text snaps atomically to its source unit", () => {
    const body = "Fish &amp; chips forever.\n";
    const { root } = mount(body);
    const projection = buildProjection(root);
    // Rendered text is "Fish & chips forever." — the "&" leaf is atomic.
    const amp = domPointAt(root, "&");
    const start = projection.domPointToSource(amp.node, amp.offset, "start");
    const source = body.slice(start!, start! + "&amp;".length);
    expect(source).toBe("&amp;");
  });

  test("selection inside a GFM table cell maps exactly", () => {
    const body = "| Col A | Col B |\n| --- | --- |\n| left cell | right cell |\n";
    const { root } = mount(body);
    const projection = buildProjection(root);
    const point = domPointAt(root, "right cell");
    const range = projection.domRangeToSource({
      startContainer: point.node,
      startOffset: point.offset,
      endContainer: point.node,
      endOffset: point.offset + "right cell".length,
    });
    expect(body.slice(range!.start, range!.end)).toBe("right cell");
  });

  test("unicode text (emoji) keeps UTF-16 offsets aligned", () => {
    const body = "Ship 🚀 tomorrow, not today.\n";
    const { root } = mount(body);
    const projection = buildProjection(root);
    const point = domPointAt(root, "tomorrow");
    const range = projection.domRangeToSource({
      startContainer: point.node,
      startOffset: point.offset,
      endContainer: point.node,
      endOffset: point.offset + "tomorrow".length,
    });
    expect(body.slice(range!.start, range!.end)).toBe("tomorrow");
  });

  test("raw HTML renders as literal text and maps identically", () => {
    const body = 'Before.\n\n<div class="x">raw</div>\n\nAfter.\n';
    const { root } = mount(body);
    // Never parsed into elements:
    expect(root.querySelector("div.x")).toBeNull();
    const projection = buildProjection(root);
    const point = domPointAt(root, '<div class="x">');
    const start = projection.domPointToSource(point.node, point.offset, "start");
    expect(body.slice(start!, start! + 4)).toBe("<div");
  });
});

describe("source → DOM", () => {
  test("a mid-paragraph source range paints exactly its text", () => {
    const body = "One two three four five.\n";
    const { root } = mount(body);
    const projection = buildProjection(root);
    const start = body.indexOf("two");
    const end = body.indexOf("four") + 4;
    const ranges = projection.sourceRangeToDomRanges({ start, end });
    const painted = ranges.map((r) => r.toString()).join("");
    expect(painted).toBe("two three four");
  });

  test("a range crossing bold produces per-leaf ranges that concatenate to the visible text", () => {
    const body = "alpha **bravo** charlie\n";
    const { root } = mount(body);
    const projection = buildProjection(root);
    const start = body.indexOf("alpha");
    const end = body.indexOf("charlie") + "charlie".length;
    const ranges = projection.sourceRangeToDomRanges({ start, end });
    expect(ranges.map((r) => r.toString()).join("")).toBe("alpha bravo charlie");
  });

  test("round-trip: selection → source → DOM re-selects the same text", () => {
    const body = "# Title\n\nSome *emphasised words* in a sentence with `code` too.\n";
    const { root } = mount(body);
    const projection = buildProjection(root);
    const start = domPointAt(root, "emphasised");
    const end = domPointAt(root, "code");
    const source = projection.domRangeToSource({
      startContainer: start.node,
      startOffset: start.offset,
      endContainer: end.node,
      endOffset: end.offset + "code".length,
    });
    const ranges = projection.sourceRangeToDomRanges(source!);
    expect(ranges.map((r) => r.toString()).join("")).toBe(
      "emphasised words in a sentence with code",
    );
  });

  test("block ranges resolve from any descendant", () => {
    const body = "First paragraph.\n\nSecond paragraph here.\n";
    const { root } = mount(body);
    const projection = buildProjection(root);
    const point = domPointAt(root, "Second");
    const block = projection.blockRangeOf(point.node);
    expect(body.slice(block!.start, block!.end)).toBe("Second paragraph here.");
  });
});
