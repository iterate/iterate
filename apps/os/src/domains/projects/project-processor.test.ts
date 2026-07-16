import { describe, expect, it } from "vitest";
import type { ProjectRpcTarget } from "../../rpc-targets.ts";
import type { StreamEvent } from "../streams/schemas.ts";
import { MemoryStreamNetwork } from "../streams/test-helpers.ts";
import { ProjectProcessor } from "./project-processor-implementation.ts";

function event(type: string, payload: Record<string, unknown>, offset = 1): StreamEvent {
  return {
    type,
    payload,
    createdAt: new Date(offset).toISOString(),
    offset,
    path: "/",
  };
}

function crossPostedEvent(
  type: string,
  payload: Record<string, unknown>,
  sourcePath: string,
  offset: number,
): StreamEvent {
  return {
    ...event(type, payload, offset),
    source: {
      crossPostedFrom: [
        {
          subscriptionKey: "cross-post:/",
          createdAt: new Date(offset).toISOString(),
          offset,
          path: sourcePath,
          projectId: "prj_test",
          type,
        },
      ],
    },
  };
}

function projectCreated(offset = 1): StreamEvent {
  return event(
    "events.iterate.com/project/created",
    {
      config: {
        creatorEmail: "owner@example.com",
        onboardingActive: true,
        slug: "demo",
      },
    },
    offset,
  );
}

function makeHarness(options: { capabilityHostBirthBarrier?: Promise<void> } = {}) {
  const network = new MemoryStreamNetwork();
  const processorWaits: { offset: number; processor: string }[] = [];
  let resolveProcessorWaitsStarted!: () => void;
  const processorWaitsStarted = new Promise<void>((resolve) => {
    resolveProcessorWaitsStarted = resolve;
  });
  const waitUntilProcessed = (processor: string) => async (input: { offset: number }) => {
    processorWaits.push({ offset: input.offset, processor });
    if (processorWaits.length === 4) resolveProcessorWaitsStarted();
    if (processor === "capability-host") await options.capabilityHostBirthBarrier;
  };
  const itx = {
    capabilityHost: {
      processor: { waitUntilProcessed: waitUntilProcessed("capability-host") },
    },
    email: { processor: { waitUntilProcessed: waitUntilProcessed("email") } },
    projectId: "prj_test",
    repo: { processor: { waitUntilProcessed: waitUntilProcessed("repo") } },
    scheduler: { processor: { waitUntilProcessed: waitUntilProcessed("scheduler") } },
    streams: { get: (path: string) => network.get(path) },
    worker: { fetch: async () => ({}) },
    search: { ensureIndex: async () => ({ created: true }) },
  } as unknown as ProjectRpcTarget;
  const processor = new ProjectProcessor({
    stream: network.get("/"),
    path: "/",
    projectId: "prj_test",
    itx,
  });
  return { network, processor, processorWaits, processorWaitsStarted };
}

describe("ProjectProcessor bootstrap", () => {
  it("creates each required sibling processor explicitly", async () => {
    const { network, processor } = makeHarness();

    await processor.ingest({ events: [projectCreated()], streamMaxOffset: 1 });

    expect(network.eventsAt("/").map((streamEvent) => streamEvent.type)).toEqual([
      "events.iterate.com/capability-host/created",
      "events.iterate.com/stream/subscription-configured",
    ]);
    expect(network.eventsAt("/scheduler/primary").map((streamEvent) => streamEvent.type)).toEqual([
      "events.iterate.com/scheduler/created",
      "events.iterate.com/stream/subscription-configured",
    ]);
    expect(network.eventsAt("/repos/config").map((streamEvent) => streamEvent.type)).toEqual([
      "events.iterate.com/repo/created",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
    ]);
    expect(network.eventsAt("/integrations/email").map((streamEvent) => streamEvent.type)).toEqual([
      "events.iterate.com/email/created",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/email/sender-allowed",
    ]);

    await expect(processor.snapshot()).resolves.toMatchObject({
      state: {
        birthCertificate: {
          config: { creatorEmail: "owner@example.com", onboardingActive: true, slug: "demo" },
        },
        onboardingActive: true,
        ready: false,
      },
    });
  });

  it("does not finish the project birth until every sibling processor has folded its batch", async () => {
    let releaseCapabilityHostBirth!: () => void;
    const capabilityHostBirthBarrier = new Promise<void>((resolve) => {
      releaseCapabilityHostBirth = resolve;
    });
    const { processor, processorWaits, processorWaitsStarted } = makeHarness({
      capabilityHostBirthBarrier,
    });

    let settled = false;
    const ingestion = processor
      .ingest({ events: [projectCreated()], streamMaxOffset: 1 })
      .then(() => {
        settled = true;
      });

    await processorWaitsStarted;
    expect(settled).toBe(false);
    expect(processorWaits).toEqual(
      expect.arrayContaining([
        { offset: 2, processor: "capability-host" },
        { offset: 2, processor: "scheduler" },
        { offset: 3, processor: "repo" },
        { offset: 3, processor: "email" },
      ]),
    );
    expect(processorWaits).toHaveLength(4);

    releaseCapabilityHostBirth();
    await ingestion;
    expect(settled).toBe(true);
  });

  it("throws when a second project birth certificate is reduced", async () => {
    const { processor } = makeHarness();
    await processor.ingest({ events: [projectCreated()], streamMaxOffset: 1 });

    await expect(
      processor.ingest({ events: [projectCreated(2)], streamMaxOffset: 2 }),
    ).rejects.toThrow("more than one project/created");
  });

  it("marks the project ready only after the config repo is ready and its worker responds", async () => {
    const { network, processor } = makeHarness();
    await processor.ingest({ events: [projectCreated()], streamMaxOffset: 1 });

    await processor.ingest({
      events: [
        crossPostedEvent(
          "events.iterate.com/repo/ready",
          {
            artifactName: "prj_test--L3JlcG9zL2NvbmZpZw",
            defaultBranch: "main",
            path: "/repos/config",
            projectId: "prj_test",
            remote: "https://example.artifacts.cloudflare.net/git/ns/x.git",
          },
          "/repos/config",
          2,
        ),
      ],
      streamMaxOffset: 2,
    });

    expect(network.eventsAt("/").map((streamEvent) => streamEvent.type)).toContain(
      "events.iterate.com/project/ready",
    );
  });
});

describe("ProjectProcessor catalogs", () => {
  it("keeps physical paths separate from explicitly created domain objects", async () => {
    const { network, processor } = makeHarness();
    await processor.ingest({ events: [projectCreated()], streamMaxOffset: 1 });

    await processor.ingest({
      events: [
        event("events.iterate.com/stream/child-stream-created", { childPath: "/agents/slack" }, 2),
        crossPostedEvent(
          "events.iterate.com/agent/created",
          {
            config: {
              llm: { model: "openai/gpt-5.6-sol" },
              systemPrompt: "Handle this Slack thread.",
            },
          },
          "/agents/slack/main/C123/ts-1",
          3,
        ),
      ],
      streamMaxOffset: 3,
    });

    await expect(processor.snapshot()).resolves.toMatchObject({
      state: {
        agents: [{ path: "/agents/slack/main/C123/ts-1" }],
        streams: [{ path: "/agents/slack" }],
      },
    });
    expect(network.eventsAt("/agents/slack")).toEqual([]);
  });
});
