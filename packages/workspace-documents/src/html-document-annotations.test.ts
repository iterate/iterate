import { describe, expect, it } from "vitest";
import {
  annotationsSourceForHtmlDocument,
  transformHtmlDocumentAnnotations,
} from "./html-document-annotations.ts";

const HTML = "<!doctype html>\n<html><body><h1>Launch review</h1></body></html>\n";

describe("HTML document review payload", () => {
  it("stores an RFM payload in an inert JSON envelope", () => {
    const source = transformHtmlDocumentAnnotations(HTML, () => "# Review\n\n---\ncomments: {}\n");

    expect(source).toContain('<script type="application/json" data-roughdraft="v1">');
    expect(source).toContain(HTML);
    expect(annotationsSourceForHtmlDocument(source)).toBe("# Review\n\n---\ncomments: {}\n");
  });

  it("updates only the payload and safely escapes closing script text", () => {
    const withReview = transformHtmlDocumentAnnotations(HTML, () => "First pass");
    const updated = transformHtmlDocumentAnnotations(
      withReview,
      (payload) => `${payload}</script>`,
    );

    expect(updated.match(/data-roughdraft="v1"/g)).toHaveLength(1);
    expect(updated.match(/<\/script>/g)).toHaveLength(1);
    expect(annotationsSourceForHtmlDocument(updated)).toBe("First pass</script>");
  });

  it("removes the envelope when the review payload becomes empty", () => {
    const withReview = transformHtmlDocumentAnnotations(HTML, () => "First pass");
    expect(transformHtmlDocumentAnnotations(withReview, () => "")).toBe(HTML);
  });

  it("does not treat ordinary HTML as a review payload", () => {
    expect(annotationsSourceForHtmlDocument(HTML)).toBe("");
    expect(
      annotationsSourceForHtmlDocument(`${HTML}<script type="application/json">{}</script>\n`),
    ).toBe("");
  });

  it.each([
    `${HTML}<script type="application/json" data-roughdraft="v1">not json</script>\n`,
    `${HTML}<script type="application/json" data-roughdraft="v1">{}</script>\n`,
    `${HTML}<script type="application/json" data-roughdraft="v1">"review"`,
    `${HTML}<script type="application/json" data-roughdraft="v1">"review"</script>\n<p>after</p>`,
  ])("refuses a malformed recognized envelope", (source) => {
    expect(() => annotationsSourceForHtmlDocument(source)).toThrow(
      "Invalid Roughdraft review envelope",
    );
    expect(() => transformHtmlDocumentAnnotations(source, () => "replacement")).toThrow(
      "Invalid Roughdraft review envelope",
    );
  });

  it("preserves the complete source when a mutation has no effect", () => {
    const withReview = transformHtmlDocumentAnnotations(HTML, () => "First pass");
    expect(transformHtmlDocumentAnnotations(withReview, (payload) => payload)).toBe(withReview);
  });
});
