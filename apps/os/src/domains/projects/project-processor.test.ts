import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../streams/schemas.ts";
import type { ProjectRpcTarget } from "../../rpc-targets.ts";
import { MemoryStreamNetwork } from "../streams/test-helpers.ts";
import { ProjectProcessor } from "./project-processor-implementation.ts";

function event(type: string, payload: Record<string, unknown>, offset = 1): StreamEvent {
  return {
    type,
    payload,
    createdAt: new Date(offset).toISOString(),
    offset,
    path: "/projects/test",
  };
}

function makeHarness() {
  const network = new MemoryStreamNetwork();
  const itx = {
    projectId: "prj_test",
    streams: { get: (path: string) => network.get(path) },
    // The repo-created lane probes the default project worker before
    // committing project/created; the fake worker is always ready.
    worker: { fetch: async () => ({}) },
    // The create saga ensures the project's search instance at birth
    // (best-effort); the fake resolves so the saga's Promise.all settles.
    search: { ensureIndex: async () => ({ created: true }) },
  } as unknown as ProjectRpcTarget;
  const processor = new ProjectProcessor({
    stream: network.get("/"),
    path: "/",
    projectId: "prj_test",
    itx,
  });
  return { network, processor };
}

describe("ProjectProcessor bootstrap", () => {
  it("arms the config repo on its own stream: processor subscription, cross-post to /, create request", async () => {
    const { network, processor } = makeHarness();

    await processor.ingest({
      events: [
        event("events.iterate.com/project/create-requested", {
          projectId: "prj_test",
          slug: "demo",
        }),
      ],
      streamMaxOffset: 1,
    });

    const configRepo = network.eventsAt("/repos/config");
    expect(configRepo.map((streamEvent) => streamEvent.type)).toEqual([
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/repo/create-requested",
    ]);
    // The cross-post rule copies EVERY config-repo event onto the project
    // stream `/` — full history, so the saga's repo/created arrives too.
    expect(configRepo[1]!.payload).toMatchObject({
      subscriptionKey: "cross-post:/",
      description:
        "Special project config repo: every event is cross-posted to the project root so the project processor can react when config changes.",
      delivery: { mode: "push", expression: ["streams", ["get", "/"], "acceptCrossPost"] },
      deliver: "all",
    });
    expect(configRepo[2]!.payload).toEqual({ path: "/repos/config", projectId: "prj_test" });
    // Nothing repo-shaped lands on `/` first-hand anymore; the project stream
    // only carries its own saga events plus cross-posted copies.
    expect(
      network.eventsAt("/").filter((streamEvent) => streamEvent.type.includes("/repo/")),
    ).toEqual([]);
  });

  it("completes the saga from the (cross-posted) repo/created fact for the config repo", async () => {
    const { network, processor } = makeHarness();

    await processor.ingest({
      events: [
        event("events.iterate.com/project/create-requested", {
          projectId: "prj_test",
          slug: "demo",
        }),
      ],
      streamMaxOffset: 1,
    });
    await processor.ingest({
      events: [
        {
          ...event(
            "events.iterate.com/repo/created",
            {
              artifactName: "prj_test--L3JlcG9zL2NvbmZpZw",
              defaultBranch: "main",
              path: "/repos/config",
              projectId: "prj_test",
              remote: "https://example.artifacts.cloudflare.net/git/ns/x.git",
            },
            2,
          ),
          // As delivered on `/`: a cross-posted copy with provenance.
          source: {
            crossPostedFrom: [
              {
                subscriptionKey: "cross-post:/",
                createdAt: new Date(2).toISOString(),
                offset: 4,
                path: "/repos/config",
                projectId: "prj_test",
                type: "events.iterate.com/repo/created",
              },
            ],
          },
        },
      ],
      streamMaxOffset: 2,
    });

    const rootTypes = network.eventsAt("/").map((streamEvent) => streamEvent.type);
    expect(rootTypes).toContain("events.iterate.com/project/created");
  });
});

describe("ProjectProcessor agent birth", () => {
  it("appends only processor subscriptions at birth — policy comes from the project worker", async () => {
    const { network, processor } = makeHarness();

    await processor.ingest({
      events: [
        event("events.iterate.com/stream/child-stream-created", {
          childPath: "/agents/demo",
        }),
      ],
      streamMaxOffset: 1,
    });

    // Mechanics only. System prompt, model selection, capability mounts,
    // and boot context are appended by the project worker via
    // itx.agents.defaults (see agents/agent-defaults.test.ts).
    const born = network.eventsAt("/agents/demo").map((streamEvent) => streamEvent.type);
    // agent processor + capability-host — no separate LLM provider processors.
    expect(born).toEqual([
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
    ]);
  });
});
