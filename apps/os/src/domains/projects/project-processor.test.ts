import { describe, expect, it } from "vitest";
import type { ProjectRpcTarget } from "../../rpc-targets.ts";
import { MemoryStreamNetwork, driveProcessor } from "../streams/test-helpers.ts";
import { ProjectProcessor } from "./project-processor-implementation.ts";

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
  const stream = network.get("/");
  const processor = new ProjectProcessor({
    stream,
    path: "/",
    projectId: "prj_test",
    itx,
  });
  return { network, stream, driver: driveProcessor(processor, stream) };
}

describe("ProjectProcessor bootstrap", () => {
  it("arms the config repo on its own stream: processor subscription, cross-post to /, create request", async () => {
    const { network, stream, driver } = makeHarness();

    await stream.append({
      type: "events.iterate.com/project/create-requested",
      payload: { projectId: "prj_test", slug: "demo" },
    });
    await driver.deliver();

    // Root capability-host birth is synchronous in projects.create(), not a
    // delayed responsibility of this bootstrap saga. Fast-path callers can
    // therefore pipeline through the returned root itx safely.
    expect(network.eventsAt("/").map((event) => event.type)).toEqual([
      "events.iterate.com/project/create-requested",
    ]);

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
    const { network, stream, driver } = makeHarness();

    await stream.append({
      type: "events.iterate.com/project/create-requested",
      payload: { projectId: "prj_test", slug: "demo" },
    });
    await driver.deliver();
    await stream.append({
      type: "events.iterate.com/repo/created",
      payload: {
        artifactName: "prj_test--L3JlcG9zL2NvbmZpZw",
        defaultBranch: "main",
        path: "/repos/config",
        projectId: "prj_test",
        remote: "https://example.artifacts.cloudflare.net/git/ns/x.git",
      },
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
    });
    await driver.deliver();

    const rootTypes = network.eventsAt("/").map((streamEvent) => streamEvent.type);
    expect(rootTypes).toContain("events.iterate.com/project/created");
  });
});

describe("ProjectProcessor agent birth", () => {
  it("declares the capability ancestor before processor subscriptions — policy comes from the project worker", async () => {
    const { network, stream, driver } = makeHarness();

    await stream.append({
      type: "events.iterate.com/stream/child-stream-created",
      payload: { childPath: "/agents/demo" },
    });
    await driver.deliver();

    // Mechanics only. The capability host's relationship is explicit and
    // replayable; system prompt, model selection, capability mounts, and boot
    // context are appended by the project worker via itx.agents.defaults (see
    // agents/agent-defaults.test.ts).
    const born = network.eventsAt("/agents/demo");
    expect(born.map((streamEvent) => streamEvent.type)).toEqual([
      "events.iterate.com/capability-host/ancestor-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
    ]);
    expect(born[0]?.payload).toEqual({ ancestorPath: "/" });
  });

  it("declares routed web conversations under root and real child agents under their parent", async () => {
    const { network, stream, driver } = makeHarness();

    await stream.append({
      type: "events.iterate.com/stream/child-stream-created",
      payload: { childPath: "/agents/web/2026-07-15t21-56-48-076z" },
    });
    await driver.deliver();
    await stream.append({
      type: "events.iterate.com/stream/child-stream-created",
      payload: { childPath: "/agents/web/2026-07-15t21-56-48-076z/researcher" },
    });
    await driver.deliver();

    expect(network.eventsAt("/agents/web/2026-07-15t21-56-48-076z")[0]?.payload).toEqual({
      ancestorPath: "/",
    });
    expect(network.eventsAt("/agents/web/2026-07-15t21-56-48-076z/researcher")[0]?.payload).toEqual(
      { ancestorPath: "/agents/web/2026-07-15t21-56-48-076z" },
    );
  });
});
