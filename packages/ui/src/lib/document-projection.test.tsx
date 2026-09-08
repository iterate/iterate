// @vitest-environment jsdom
/** @jsxImportSource react */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { MarkdownDocumentRenderer } from "../components/markdown-document-renderer.tsx";
import { buildDocumentProjection } from "./document-projection.ts";

function mount(markdown: string) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<MarkdownDocumentRenderer markdown={markdown} />);
  return host.firstElementChild as HTMLElement;
}

function pointAt(root: HTMLElement, text: string) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    // SHOW_TEXT guarantees Text; TreeWalker exposes general Node.
    const nodeText = node as Text;
    const offset = nodeText.data.indexOf(text);
    if (offset !== -1) return { node: nodeText, offset };
  }
  throw new Error(`Rendered document does not contain ${JSON.stringify(text)}.`);
}

describe("document source projection", () => {
  test("maps plain prose and inline formatting to UTF-16 display offsets", () => {
    const markdown = "Plain **bold middle** after.\n";
    const root = mount(markdown);
    const projection = buildDocumentProjection(root);
    const start = pointAt(root, "Plain");
    const end = pointAt(root, "middle");
    const range = projection.domRangeToSource({
      startContainer: start.node,
      startOffset: start.offset,
      endContainer: end.node,
      endOffset: end.offset + "middle".length,
    });

    expect(markdown.slice(range!.start, range!.end)).toBe("Plain **bold middle");
  });

  test.each(["Next paragraph.", "- Next list item."])(
    "a paragraph selection ending at the start of %s excludes that block",
    (following) => {
      const markdown = `Selected paragraph.\n\n${following}\n`;
      const root = mount(markdown);
      const projection = buildDocumentProjection(root);
      const start = pointAt(root, "Selected paragraph.");
      const next = pointAt(root, "Next");
      // Chromium's triple-click ends at offset zero of the following element.
      const range = projection.domRangeToSource({
        startContainer: start.node,
        startOffset: 0,
        endContainer: next.node.parentElement!,
        endOffset: 0,
      });

      expect(markdown.slice(range!.start, range!.end).trim()).toBe("Selected paragraph.");
    },
  );

  test("maps fenced code to its body rather than an info string", () => {
    const markdown = "```python\npython\n```\n";
    const root = mount(markdown);
    const projection = buildDocumentProjection(root);
    const point = pointAt(root, "python");
    const range = projection.domRangeToSource({
      startContainer: point.node,
      startOffset: point.offset,
      endContainer: point.node,
      endOffset: point.offset + "python".length,
    });

    expect(range).toEqual({
      start: markdown.indexOf("python\n```"),
      end: markdown.indexOf("python\n```") + "python".length,
    });
  });

  test("maps blockquote continuations and table cells without guessing from text content", () => {
    const markdown = "> first line\n> second line\n\n| A | B |\n| --- | --- |\n| left | right |\n";
    const root = mount(markdown);
    const projection = buildDocumentProjection(root);
    const quote = pointAt(root, "second line");
    const cell = pointAt(root, "right");

    expect(
      projection.domRangeToSource({
        startContainer: quote.node,
        startOffset: quote.offset,
        endContainer: quote.node,
        endOffset: quote.offset + "second line".length,
      }),
    ).toEqual({
      start: markdown.indexOf("second line"),
      end: markdown.indexOf("second line") + 11,
    });
    expect(
      projection.domRangeToSource({
        startContainer: cell.node,
        startOffset: cell.offset,
        endContainer: cell.node,
        endOffset: cell.offset + "right".length,
      }),
    ).toEqual({ start: markdown.lastIndexOf("right"), end: markdown.lastIndexOf("right") + 5 });
  });

  test("keeps entity decoding atomic and retains emoji UTF-16 offsets", () => {
    const markdown = "Fish &amp; chips 🚀 tomorrow.\n";
    const root = mount(markdown);
    const projection = buildDocumentProjection(root);
    const entity = pointAt(root, "&");
    const tomorrow = pointAt(root, "tomorrow");

    const entityOffset = projection.domPointToSource(entity.node, entity.offset, "start");
    expect(markdown.slice(entityOffset!, entityOffset! + "&amp;".length)).toBe("&amp;");
    expect(
      projection.domRangeToSource({
        startContainer: tomorrow.node,
        startOffset: tomorrow.offset,
        endContainer: tomorrow.node,
        endOffset: tomorrow.offset + "tomorrow".length,
      }),
    ).toEqual({ start: markdown.indexOf("tomorrow"), end: markdown.indexOf("tomorrow") + 8 });
  });

  test("renders HTML literally and keeps unsafe destinations inert", () => {
    const markdown =
      '<div class="unsafe">raw</div>\n\n[bad](javascript:alert(1)) [good](https://iterate.com)\n';
    const root = mount(markdown);

    expect(root.querySelector("div.unsafe")).toBeNull();
    expect(root.textContent).toContain('<div class="unsafe">raw</div>');
    expect(root.querySelector('a[href^="javascript"]')).toBeNull();
    expect(root.querySelector('a[href="https://iterate.com"]')?.getAttribute("rel")).toBe(
      "noreferrer",
    );
  });

  test("source-to-DOM ranges concatenate visible text across Markdown marks", () => {
    const markdown = "alpha **bravo** charlie\n";
    const root = mount(markdown);
    const projection = buildDocumentProjection(root);
    const ranges = projection.sourceRangeToDomRanges({
      start: markdown.indexOf("alpha"),
      end: markdown.indexOf("charlie") + "charlie".length,
    });

    expect(ranges.map((range) => range.toString()).join("")).toBe("alpha bravo charlie");
  });
});
