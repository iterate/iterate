import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStreamNetwork, driveProcessor } from "iterate/processors/testing";
import type { ProjectRpcTarget } from "../../rpc-targets.ts";
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

function makeHarness(
  options: {
    processorBirthBarriers?: Partial<Record<ProcessorName, Promise<void>>>;
    workerResponses?: Response[];
  } = {},
) {
  const network = new MemoryStreamNetwork();
  let workerFetchCalls = 0;
  const processorWaits: { offset: number; processor: string }[] = [];
  const processorWaitTimeouts: (number | undefined)[] = [];
  const processorWaitStarted = {} as Record<ProcessorName, Promise<void>>;
  const resolveProcessorWaitStarted = {} as Record<ProcessorName, () => void>;
  for (const processor of ["capability-host", "scheduler", "repo", "email"] as const) {
    processorWaitStarted[processor] = new Promise<void>((resolve) => {
      resolveProcessorWaitStarted[processor] = resolve;
    });
  }
  const waitUntilProcessed =
    (processor: ProcessorName) => async (input: { offset: number; timeoutMs?: number }) => {
      processorWaits.push({ offset: input.offset, processor });
      processorWaitTimeouts.push(input.timeoutMs);
      resolveProcessorWaitStarted[processor]();
      await options.processorBirthBarriers?.[processor];
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
    processorWaitStarted,
    processorWaitTimeouts,
    stream,
    workerFetchCalls: () => workerFetchCalls,
  };
}

type ProcessorName = "capability-host" | "email" | "repo" | "scheduler";

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
    expect(network.eventsAt("/")[2]?.idempotencyKey).toContain("#capability-host");
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

  it("does not finish project birth until every sibling processor has folded its batch", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const releases = {} as Record<Exclude<ProcessorName, "email">, () => void>;
    const barriers = {} as Record<Exclude<ProcessorName, "email">, Promise<void>>;
    for (const processor of ["capability-host", "scheduler", "repo"] as const) {
      barriers[processor] = new Promise<void>((resolve) => {
        releases[processor] = resolve;
      });
    }
    const { driver, processorWaits, processorWaitStarted, processorWaitTimeouts, stream } =
      makeHarness({
        processorBirthBarriers: barriers,
      });

    await stream.append(PROJECT_CREATED);
    let settled = false;
    const delivery = driver.deliver().then(() => {
      settled = true;
    });

    await processorWaitStarted["capability-host"];
    expect(settled).toBe(false);
    expect(processorWaits).toEqual([{ offset: 3, processor: "capability-host" }]);

    now += 10_000;
    releases["capability-host"]();
    await processorWaitStarted.scheduler;
    expect(processorWaits).toEqual([
      { offset: 3, processor: "capability-host" },
      { offset: 2, processor: "scheduler" },
    ]);

    now += 5_000;
    releases.scheduler();
    await processorWaitStarted.repo;
    expect(processorWaits).toEqual([
      { offset: 3, processor: "capability-host" },
      { offset: 2, processor: "scheduler" },
      { offset: 3, processor: "repo" },
    ]);

    now += 5_000;
    releases.repo();
    await processorWaitStarted.email;
    expect(processorWaits).toEqual([
      { offset: 3, processor: "capability-host" },
      { offset: 2, processor: "scheduler" },
      { offset: 3, processor: "repo" },
      { offset: 3, processor: "email" },
    ]);
    expect(processorWaitTimeouts).toEqual([60_000, 50_000, 45_000, 40_000]);

    await delivery;
    expect(settled).toBe(true);
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
        payload: {},
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
