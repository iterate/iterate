import { describe, expect, it } from "vitest";
import {
  eventDocs,
  getEventDocByPath,
  getProcessorDocByPath,
  processorDocs,
  processorEventDocsPath,
  type EventDoc,
} from "~/lib/event-docs.ts";

describe("event docs catalog", () => {
  it("documents the stream processor at the public stream slug", () => {
    const processor = getProcessorDocByPath("stream");

    expect(processor?.slug).toBe("stream");
    expect(processor?.contract.slug).toBe("core");
    expect(processor?.href).toBe("/docs/streams/processors/stream");
  });

  it("maps event URL paths to docs pages under the owning processor", () => {
    const event = getEventDocByPath("stream/created");

    expect(event?.type).toBe("events.iterate.com/stream/created");
    expect(event?.href).toBe("/docs/streams/processors/stream/events/created");
  });

  it("keeps the stream/create alias navigable", () => {
    expect(getEventDocByPath("stream/create")).toBe(getEventDocByPath("stream/created"));
  });

  it("keeps full event paths in docs links when the event namespace differs from the page slug", () => {
    // No current contract declares an event outside its own namespace, so
    // exercise the path mechanics directly.
    const event = {
      eventPath: "os/project-created",
      eventSlug: "project-created",
      processor: { slug: "project" },
    } as EventDoc;

    expect(processorEventDocsPath(event)).toBe(
      "/docs/streams/processors/project/events/os/project-created",
    );
  });

  it("builds a non-empty processor and event catalog", () => {
    expect(processorDocs.length).toBeGreaterThan(5);
    expect(eventDocs.length).toBeGreaterThan(10);
  });
});
