import { describe, expect, it } from "vitest";
import { addComment, addThread, parseAnnotatedMarkdown } from "iterate/annotated-markdown";
import {
  annotationsSourceForHtmlDocument,
  transformHtmlDocumentAnnotations,
} from "./html-document-annotations.ts";

const HTML = "<!doctype html>\n<html><body><h1>Launch review</h1></body></html>\n";

describe("HTML document annotations", () => {
  it("stores comments in a non-rendering JSON envelope and reopens them", () => {
    const withThread = transformHtmlDocumentAnnotations(HTML, (source) => {
      const doc = parseAnnotatedMarkdown(source);
      if (doc.kind !== "structured") throw new Error("expected structured document");
      return addThread(doc, {
        author: "reviewer",
        authorDisplay: "Reviewer",
        body: "Tighten the rollout notes.",
        createdAt: "2026-07-29T16:00:00Z",
      }).raw;
    });

    expect(withThread).toContain('<script type="application/json" data-iterate-annotations="v1">');
    expect(withThread).not.toContain("\n## Discussion\n");

    const reopened = parseAnnotatedMarkdown(annotationsSourceForHtmlDocument(withThread));
    expect(reopened.kind).toBe("structured");
    if (reopened.kind !== "structured") return;
    expect(reopened.body).toBe(`${HTML}\n`);
    expect(reopened.discussion?.threads[0]?.comments[0]?.body).toBe("Tighten the rollout notes.");
  });

  it("keeps one envelope across later mutations and safely escapes closing script text", () => {
    const withThread = transformHtmlDocumentAnnotations(HTML, (source) => {
      const doc = parseAnnotatedMarkdown(source);
      if (doc.kind !== "structured") throw new Error("expected structured document");
      return addThread(doc, {
        threadId: "thread-1",
        commentId: "comment-1",
        author: "reviewer",
        authorDisplay: "Reviewer",
        body: "First pass",
        createdAt: "2026-07-29T16:00:00Z",
      }).raw;
    });
    const withReply = transformHtmlDocumentAnnotations(withThread, (source) => {
      const doc = parseAnnotatedMarkdown(source);
      if (doc.kind !== "structured") throw new Error("expected structured document");
      return addComment(doc, {
        commentId: "comment-2",
        threadId: "thread-1",
        author: "agent",
        authorDisplay: "Agent",
        body: "Literal </script> stays inert.",
        createdAt: "2026-07-29T16:01:00Z",
      }).raw;
    });

    expect(withReply.match(/data-iterate-annotations="v1"/g)).toHaveLength(1);
    expect(withReply.match(/<\/script>/g)).toHaveLength(1);

    const reopened = parseAnnotatedMarkdown(annotationsSourceForHtmlDocument(withReply));
    expect(reopened.kind).toBe("structured");
    if (reopened.kind !== "structured") return;
    expect(reopened.discussion?.threads[0]?.comments[1]?.body).toBe(
      "Literal </script> stays inert.",
    );
  });

  it("leaves ordinary HTML and unrelated JSON scripts alone", () => {
    const source = `${HTML}<script type="application/json">{"ok":true}</script>\n`;
    expect(annotationsSourceForHtmlDocument(source)).toBe(source);
  });
});
