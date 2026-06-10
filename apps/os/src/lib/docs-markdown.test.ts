import { describe, expect, it } from "vitest";
import { handleDocsMarkdownFetch } from "~/lib/docs-markdown.ts";

describe("docs markdown responses", () => {
  it("serves Markdown for docs pages when requested by Accept header", async () => {
    const response = handleDocsMarkdownFetch({
      appBaseUrl: "https://os.iterate.com",
      request: new Request("https://os.iterate.com/docs/streams/processors/stream", {
        headers: { accept: "text/markdown, text/html;q=0.9" },
      }),
    });

    expect(response?.headers.get("content-type")).toContain("text/markdown");
    expect(response?.headers.get("vary")).toBe("accept");
    await expect(response?.text()).resolves.toContain("# stream");
  });

  it("keeps ordinary browser accepts on HTML", () => {
    const response = handleDocsMarkdownFetch({
      appBaseUrl: "https://os.iterate.com",
      request: new Request("https://os.iterate.com/docs/streams/processors/stream", {
        headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      }),
    });

    expect(response).toBeNull();
  });

  it("serves Markdown from index.md URLs without needing Accept negotiation", async () => {
    const response = handleDocsMarkdownFetch({
      appBaseUrl: "https://os.iterate.com",
      request: new Request("https://os.iterate.com/docs/streams/processors/stream/index.md"),
    });

    expect(response?.headers.get("content-type")).toContain("text/markdown");
    await expect(response?.text()).resolves.toContain("Maintains the stream's own reduced state.");
  });

  it("serves root llms.txt for OS discovery", async () => {
    const response = handleDocsMarkdownFetch({
      appBaseUrl: "https://os.iterate.com",
      request: new Request("https://os.iterate.com/llms.txt"),
    });

    await expect(response?.text()).resolves.toContain("## Stream Processors");
  });

  it("keeps docs llms.txt as a discovery alias", async () => {
    const response = handleDocsMarkdownFetch({
      appBaseUrl: "https://os.iterate.com",
      request: new Request("https://os.iterate.com/docs/llms.txt"),
    });

    await expect(response?.text()).resolves.toContain("## Stream Processors");
  });

  it("serves root llms.txt for the events host", async () => {
    const response = handleDocsMarkdownFetch({
      appBaseUrl: "https://os.iterate.com",
      request: new Request("https://events.iterate.com/llms.txt"),
    });

    await expect(response?.text()).resolves.toContain("## Stream Processors");
  });

  it("maps event-host aliases to the same Markdown content", async () => {
    const response = handleDocsMarkdownFetch({
      appBaseUrl: "https://os.iterate.com",
      request: new Request("https://events.iterate.com/stream/created", {
        headers: { accept: "text/markdown" },
      }),
    });

    await expect(response?.text()).resolves.toContain("# events.iterate.com/stream/created");
  });

  it("serves canonical docs paths on the events host with Accept negotiation", async () => {
    const response = handleDocsMarkdownFetch({
      appBaseUrl: "https://os.iterate.com",
      request: new Request("https://events.iterate.com/docs/streams/processors/stream", {
        headers: { accept: "text/markdown" },
      }),
    });

    await expect(response?.text()).resolves.toContain("# stream");
  });

  it("serves canonical docs index.md paths on the events host", async () => {
    const response = handleDocsMarkdownFetch({
      appBaseUrl: "https://os.iterate.com",
      request: new Request("https://events.iterate.com/docs/streams/processors/stream/index.md"),
    });

    await expect(response?.text()).resolves.toContain("Maintains the stream's own reduced state.");
  });
});
