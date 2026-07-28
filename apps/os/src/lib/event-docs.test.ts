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

  it("uses the event namespace as the agent processor's public docs path", () => {
    const event = getEventDocByPath("agents/context-added");

    expect(event?.processor.slug).toBe("agents");
    expect(event?.processor.contractSlug).toBe("agent");
    expect(event?.href).toBe("/docs/streams/processors/agents/events/context-added");
    expect(event?.routeParams).toEqual({
      processorSlug: "agents",
      _splat: "context-added",
    });
  });

  it("does not resolve events under the wrong processor route", () => {
    expect(
      getEventDocByProcessorRoute({
        processorSlug: "stream",
        eventPath: "agents/context-added",
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

describe("event docs cross-references", () => {
  it("links events to the processors that emit and consume them", () => {
    const event = getEventDocByType("events.iterate.com/agent/summary-updated");

    expect(event?.emittedBy.map((processor) => processor.contractSlug)).toEqual(
      expect.arrayContaining(["agent"]),
    );
    expect(event?.consumedBy.map((processor) => processor.contractSlug)).toEqual(
      expect.arrayContaining(["agent", "slack-agent"]),
    );
  });

  it("links processor consumes/emits rows to owned event docs", () => {
    const processor = getProcessorDocByPath("project");

    expect(processor?.consumesAllEvents).toBe(true);
    expect(processor?.emits.map((event) => event.type)).toContain(
      "events.iterate.com/stream/subscription-configured",
    );
    const foreignEmit = processor?.emits.find(
      (event) => event.type === "events.iterate.com/repos/create-requested",
    );
    expect(foreignEmit?.ownerContractSlug).toBe("repo");
    expect(foreignEmit?.href).toBe("/docs/streams/processors/repos/events/create-requested");
  });

  it("links processor dependencies in both directions", () => {
    const agent = getProcessorDocByPath("agent");
    const capabilityHost = getProcessorDocByPath("capability-host");

    expect(agent?.dependencies.map((dep) => dep.contractSlug)).toContain("capability-host");
    expect(capabilityHost?.dependents.map((dep) => dep.contractSlug)).toContain("agent");
  });
});
