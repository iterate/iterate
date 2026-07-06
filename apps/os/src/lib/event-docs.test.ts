import { describe, expect, it } from "vitest";
import {
  eventDocs,
  getEventDocByPath,
  getEventDocByType,
  getProcessorDocByPath,
  processorDocs,
} from "~/lib/event-docs.ts";

describe("event docs catalog", () => {
  it("documents the stream processor at the public stream slug", () => {
    const processor = getProcessorDocByPath("stream");

    expect(processor?.slug).toBe("stream");
    expect(processor?.contractSlug).toBe("core");
    expect(processor?.href).toBe("/stream");
  });

  it("maps event URL paths to public docs pages", () => {
    const event = getEventDocByPath("stream/created");

    expect(event?.type).toBe("events.iterate.com/stream/created");
    expect(event?.href).toBe("/stream/created");
    expect(event?.routeParams).toEqual({
      eventDocsProcessorSlug: "stream",
      _splat: "created",
    });
    expect(getEventDocByType("events.iterate.com/stream/created")).toBe(event);
  });

  it("keeps the stream/create alias navigable", () => {
    expect(getEventDocByPath("stream/create")).toBe(getEventDocByPath("stream/created"));
  });

  it("builds a non-empty processor and event catalog", () => {
    expect(processorDocs.length).toBeGreaterThan(5);
    expect(eventDocs.length).toBeGreaterThan(10);
  });
});
