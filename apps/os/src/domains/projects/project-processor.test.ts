import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectRpcTarget } from "../../rpc-targets.ts";
import { MemoryStreamNetwork, driveProcessor } from "../streams/test-helpers.ts";
import { workerBuildingResponse } from "../workers/worker-fetch-dispatch.ts";
import { ProjectProcessor } from "./project-processor-implementation.ts";

const PROJECT_CREATED = {
  type: "events.iterate.com/project/created" as const,
  payload: {
    config: {
      creatorEmail: "owner@example.com",
      onboardingActive: true,
      slug: "demo",
    },
  },
};

function makeHarness(options: { workerResponses?: Response[] } = {}) {
  const network = new MemoryStreamNetwork();
  let workerFetchCalls = 0;
  const processorWaits: { offset: number; processor: string }[] = [];
  const waitUntilProcessed = (processor: string) => async (input: { offset: number }) => {
    processorWaits.push({ offset: input.offset, processor });
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
    worker: {
      fetch: async () => {
        const response = options.workerResponses?.[workerFetchCalls];
        workerFetchCalls += 1;
        return response ?? new Response(null, { status: 204 });
      },
    },
    search: { ensureIndex: async () => ({ created: true }) },
  } as unknown as ProjectRpcTarget;
  const stream = network.get("/");
  const processor = new ProjectProcessor({
    stream,
    path: "/",
    projectId: "prj_test",
    itx,
  });
  return {
    driver: driveProcessor(processor, stream),
    network,
    processorWaits,
    stream,
    workerFetchCalls: () => workerFetchCalls,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("ProjectProcessor bootstrap", () => {
  it("creates each required sibling processor explicitly", async () => {
    const { driver, network, stream } = makeHarness();

    await stream.append(PROJECT_CREATED);
    await driver.deliver();

    expect(network.eventsAt("/").map((event) => event.type)).toEqual([
      "events.iterate.com/project/created",
      "events.iterate.com/capability-host/created",
      "events.iterate.com/stream/subscription-configured",
    ]);
    expect(network.eventsAt("/")[1]?.payload).toEqual({
      config: { ancestorPath: null },
    });
    expect(network.eventsAt("/scheduler/primary").map((event) => event.type)).toEqual([
      "events.iterate.com/scheduler/created",
      "events.iterate.com/stream/subscription-configured",
    ]);
    expect(network.eventsAt("/repos/config").map((event) => event.type)).toEqual([
      "events.iterate.com/repo/created",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
    ]);
    expect(network.eventsAt("/repos/config")[2]).toMatchObject({
      payload: {
        deliver: "new",
        subscriptionKey: "cross-post:/",
      },
    });
    expect(network.eventsAt("/integrations/email").map((event) => event.type)).toEqual([
      "events.iterate.com/email/created",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/email/sender-allowed",
    ]);
    await expect(driver.snapshot()).resolves.toMatchObject({
      state: {
        birthCertificate: PROJECT_CREATED.payload,
        onboardingActive: true,
        ready: false,
      },
    });
  });

  it("commits sibling births without recursively waiting on their processors", async () => {
    const { driver, network, processorWaits, stream } = makeHarness();
    await stream.append(PROJECT_CREATED);
    await driver.deliver();

    expect(processorWaits).toEqual([]);
    expect(network.eventsAt("/").map((event) => event.type)).toContain(
      "events.iterate.com/capability-host/created",
    );
    expect(network.eventsAt("/scheduler/primary")).toHaveLength(2);
    expect(network.eventsAt("/repos/config")).toHaveLength(3);
    expect(network.eventsAt("/integrations/email")).toHaveLength(3);
  });

  it("throws when a second project birth certificate is reduced", async () => {
    const { driver, stream } = makeHarness();
    await stream.append(PROJECT_CREATED);
    await driver.deliver();
    await stream.append(PROJECT_CREATED);

    await expect(driver.deliver()).rejects.toThrow("more than one project/created");
  });

  it("waits through a cold-build response before marking the project ready", async () => {
    const { driver, network, stream, workerFetchCalls } = makeHarness({
      workerResponses: [
        workerBuildingResponse(),
        Response.json({ app: "hello", projectId: "prj_test" }),
      ],
    });
    await stream.append(PROJECT_CREATED);
    await driver.deliver();

    await stream.append({
      type: "events.iterate.com/repo/ready",
      payload: {
        artifactName: "prj_test--L3JlcG9zL2NvbmZpZw",
        defaultBranch: "main",
        path: "/repos/config",
        projectId: "prj_test",
        remote: "https://example.artifacts.cloudflare.net/git/ns/x.git",
      },
      source: {
        crossPostedFrom: [
          {
            subscriptionKey: "cross-post:/",
            createdAt: new Date(2).toISOString(),
            offset: 4,
            path: "/repos/config",
            projectId: "prj_test",
            type: "events.iterate.com/repo/ready",
          },
        ],
      },
    });
    await driver.deliver();

    expect(network.eventsAt("/").map((event) => event.type)).toContain(
      "events.iterate.com/project/ready",
    );
    expect(workerFetchCalls()).toBe(2);
  });
});

describe("ProjectProcessor catalogs", () => {
  it("keeps physical paths separate from explicitly created domain objects", async () => {
    const { driver, network, stream } = makeHarness();
    await stream.append(PROJECT_CREATED);
    await driver.deliver();

    await stream.append(
      {
        type: "events.iterate.com/stream/child-stream-created",
        payload: { childPath: "/agents/slack" },
      },
      {
        type: "events.iterate.com/agent/created",
        payload: {
          config: {
            llm: { model: "openai/gpt-5.6-sol" },
            systemPrompt: "Handle this Slack thread.",
          },
        },
        source: {
          crossPostedFrom: [
            {
              subscriptionKey: "cross-post:/",
              createdAt: new Date(3).toISOString(),
              offset: 1,
              path: "/agents/slack/main/C123/ts-1",
              projectId: "prj_test",
              type: "events.iterate.com/agent/created",
            },
          ],
        },
      },
    );
    await driver.deliver();

    await expect(driver.snapshot()).resolves.toMatchObject({
      state: {
        agents: [{ path: "/agents/slack/main/C123/ts-1" }],
        streams: [{ path: "/agents/slack" }],
      },
    });
    expect(network.eventsAt("/agents/slack")).toEqual([]);
  });
});
