import { describe, expect, it } from "vitest";
import {
  eventDocs,
  getEventDocByPath,
  getEventDocByProcessorRoute,
  getEventDocByType,
  getEventDocsRouteTarget,
  getProcessorDocByPath,
  processorDocs,
} from "~/lib/event-docs.ts";

describe("event docs catalog", () => {
  it("documents the stream processor at the public stream slug", () => {
    const processor = getProcessorDocByPath("stream");

    expect(processor?.slug).toBe("stream");
    expect(processor?.contractSlug).toBe("core");
    expect(processor?.href).toBe("/docs/streams/processors/stream");
    expect(processor?.routeParams).toEqual({ processorSlug: "stream" });
  });

  it("maps event URL paths to public docs pages", () => {
    const event = getEventDocByPath("stream/created");

    expect(event?.type).toBe("events.iterate.com/stream/created");
    expect(event?.href).toBe("/docs/streams/processors/stream/events/created");
    expect(event?.routeParams).toEqual({
      processorSlug: "stream",
      _splat: "created",
    });
    expect(getEventDocByType("events.iterate.com/stream/created")).toBe(event);
  });

  it("keeps events whose public path does not start with the processor slug under the processor", () => {
    const event = getEventDocByPath("agents/user-message-received");

    expect(event?.processor.slug).toBe("agent");
    expect(event?.href).toBe("/docs/streams/processors/agent/events/agents/user-message-received");
    expect(event?.routeParams).toEqual({
      processorSlug: "agent",
      _splat: "agents/user-message-received",
    });
  });

  it("does not resolve events under the wrong processor route", () => {
    expect(
      getEventDocByProcessorRoute({
        processorSlug: "stream",
        eventPath: "agents/user-message-received",
      }),
    ).toBeUndefined();
  });

  it("resolves processor aliases before checking route event ownership", () => {
    expect(
      getEventDocByProcessorRoute({
        processorSlug: "core",
        eventPath: "created",
      }),
    ).toMatchObject({
      processor: { slug: "stream" },
      href: "/docs/streams/processors/stream/events/created",
    });
  });

  it("keeps the stream/create alias navigable", () => {
    expect(getEventDocByPath("stream/create")).toBe(getEventDocByPath("stream/created"));
  });

  it("resolves an empty splat match as the processor overview", () => {
    const target = getEventDocsRouteTarget({
      eventDocsProcessorSlug: "stream",
      _splat: undefined,
    });

    expect(target).toMatchObject({
      kind: "processor",
      processor: { contractSlug: "core", href: "/docs/streams/processors/stream" },
    });
  });

  it("resolves a non-empty splat match as an event page", () => {
    const target = getEventDocsRouteTarget({
      eventDocsProcessorSlug: "stream",
      _splat: "created",
    });

    expect(target).toMatchObject({
      kind: "event",
      event: {
        type: "events.iterate.com/stream/created",
        href: "/docs/streams/processors/stream/events/created",
      },
    });
  });

  it("builds a non-empty processor and event catalog", () => {
    expect(processorDocs.length).toBeGreaterThan(5);
    expect(eventDocs.length).toBeGreaterThan(10);
  });
});
