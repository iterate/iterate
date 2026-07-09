import { describe, expect, it } from "vitest";
import {
  documentedProcessorContracts,
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
    const event = getEventDocByPath("agents/message-received");

    expect(event?.processor.slug).toBe("agent");
    expect(event?.href).toBe("/docs/streams/processors/agent/events/agents/message-received");
    expect(event?.routeParams).toEqual({
      processorSlug: "agent",
      _splat: "agents/message-received",
    });
  });

  it("does not resolve events under the wrong processor route", () => {
    expect(
      getEventDocByProcessorRoute({
        processorSlug: "stream",
        eventPath: "agents/message-received",
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

describe("event docs examples", () => {
  it("documents at least one example for every owned event type", () => {
    const undocumented = eventDocs
      .filter((event) => event.examples.length === 0)
      .map((event) => event.type);
    expect(
      undocumented,
      "every contract event needs an `examples` entry for the docs site",
    ).toEqual([]);
  });

  it("parses every example payload against its event's payload schema", () => {
    for (const contract of documentedProcessorContracts) {
      for (const [type, definition] of Object.entries(contract.events)) {
        for (const example of definition.examples ?? []) {
          const result = definition.payloadSchema.safeParse(example.payload);
          expect(
            result.success,
            `${type} example "${example.description}" must parse: ${result.error}`,
          ).toBe(true);
        }
      }
    }
  });

  it("keeps every example payload JSON-serializable", () => {
    for (const event of eventDocs) {
      for (const example of event.examples) {
        const roundTripped: unknown = JSON.parse(JSON.stringify(example.payload));
        expect(roundTripped, `${event.type} example "${example.description}"`).toEqual(
          example.payload,
        );
      }
    }
  });
});

describe("event docs cross-references", () => {
  it("links events to the processors that emit and consume them", () => {
    const event = getEventDocByType("events.iterate.com/agent/llm-request-completed");

    expect(event?.emittedBy.map((processor) => processor.contractSlug)).toEqual(
      expect.arrayContaining(["cloudflare-ai", "openai-ws"]),
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
      (event) => event.type === "events.iterate.com/repo/create-requested",
    );
    expect(foreignEmit?.ownerContractSlug).toBe("repo");
    expect(foreignEmit?.href).toBe("/docs/streams/processors/repo/events/create-requested");
  });

  it("links processor dependencies in both directions", () => {
    const agent = getProcessorDocByPath("agent");
    const capabilityHost = getProcessorDocByPath("capability-host");

    expect(agent?.dependencies.map((dep) => dep.contractSlug)).toContain("capability-host");
    expect(capabilityHost?.dependents.map((dep) => dep.contractSlug)).toContain("agent");
  });
});
