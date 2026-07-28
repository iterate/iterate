// The project processor's executable spec, on the generic step harness from
// iterate/processors/testing: the REAL StreamProcessorRunner over the shared
// MemoryStream (production idempotency semantics: a same-key append with a
// different body is REJECTED). The harness stream is joined to a
// MemoryStreamNetwork so the birth saga's cross-stream appends (scheduler,
// config repo, email router) are observable per path. The project-specific
// fakes — the itx sibling facades, the worker probe, the Cloudflare
// custom-domain provisioner — are defined here and wired in createProcessor.

import { describe, expect, it, vi } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  MemoryStreamNetwork,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import type { ProjectDirectoryRecord } from "../../project-directory.ts";
import type { ProjectRpcTarget } from "../../rpc-targets.ts";
import { defaultProjectWorkerRef } from "../repos/utils.ts";
import { projectCreationEvents } from "./project-defaults.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";
import { ProjectProcessor } from "./project-processor-implementation.ts";

type ProjectEventInput = ConsumedInput<ProjectProcessorContract>;

const PROJECT_CREATED = {
  type: "events.iterate.com/project/created",
  payload: {
    config: {
      creatorEmail: "owner@example.com",
      onboardingActive: true,
      slug: "demo",
    },
  },
} satisfies ProjectEventInput;

/** The copied config-repo terminal certificate received on the project root. */
const CONFIG_REPO_READY = {
  type: "events.iterate.com/repos/created",
  payload: {
    request: { type: "empty" },
    artifactName: "prj_test--L3JlcG9zL2NvbmZpZw",
    defaultBranch: "main",
    remote: "https://example.artifacts.cloudflare.net/git/ns/x.git",
  },
  source: {
    copiedFrom: [
      {
        subscriptionKey: "project-config-to-root",
        streamId: "11111111-1111-4111-8111-111111111111",
        streamCreatedAt: new Date(1).toISOString(),
        cursorChangedAtSourceOffset: 3,
        createdAt: new Date(2).toISOString(),
        offset: 4,
        path: "/repos/config",
        projectId: "prj_test",
        type: "events.iterate.com/repos/created",
      },
    ],
  },
} satisfies ProjectEventInput;

const PROJECT: ProjectDirectoryRecord = {
  id: "prj_garple",
  name: "Garple",
  organizationId: "org_1",
  slug: "garple",
};

function errorCauseMessages(error: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<object>();
  let candidate = error;
  while (typeof candidate === "object" && candidate !== null && !seen.has(candidate)) {
    seen.add(candidate);
    if (candidate instanceof Error) messages.push(`${candidate.name}: ${candidate.message}`);
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return messages;
}

type SiblingName = "capability-host" | "scheduler" | "repo" | "email";
const SIBLINGS = ["capability-host", "scheduler", "repo", "email"] as const;

/** The generic harness plus the project's fakes (itx sibling facades, worker
 * probe, custom-domain provisioner), wired in createProcessor. */
function makeProjectHarness(
  options: {
    substrate?: HarnessSubstrate;
    /** Served to successive worker readiness handshakes; `true` after the list runs out. */
    workerReadinessResults?: Array<true | false | Error>;
    /** Virtual duration of each readiness call, clamped to its cold-build budget. */
    workerReadinessAdvanceMs?: number[];
    /** Parks the named sibling's waitUntilProcessed until the promise resolves. */
    siblingWaitBarriers?: Partial<Record<SiblingName, Promise<void>>>;
    /** Advance the virtual clock by this much inside the named sibling's wait,
     * to observe the shrinking birth-barrier budget. */
    clockAdvanceBySibling?: Partial<Record<SiblingName, number>>;
    processorClass?: typeof ProjectProcessor;
  } = {},
) {
  let workerReadinessCalls = 0;
  const workerReadinessDispatches: Array<{
    buildBudgetMs?: number;
    flattenNestedPaths?: boolean;
  }> = [];
  const siblingWaits: { processor: SiblingName; offset: number; timeoutMs?: number }[] = [];
  const siblingWaitStarted = {} as Record<SiblingName, Promise<void>>;
  const resolveSiblingWaitStarted = {} as Record<SiblingName, () => void>;
  for (const sibling of SIBLINGS) {
    siblingWaitStarted[sibling] = new Promise<void>((resolve) => {
      resolveSiblingWaitStarted[sibling] = resolve;
    });
  }
  const clockBox = { advance: (_ms: number) => {} };
  const waitUntilProcessed =
    (sibling: SiblingName) => async (input: { offset: number; timeoutMs?: number }) => {
      siblingWaits.push({ processor: sibling, offset: input.offset, timeoutMs: input.timeoutMs });
      resolveSiblingWaitStarted[sibling]();
      clockBox.advance(options.clockAdvanceBySibling?.[sibling] ?? 0);
      await options.siblingWaitBarriers?.[sibling];
    };
  const customDomains = {
    ensure: vi.fn(async () => {}),
    readProject: vi.fn(async (): Promise<ProjectDirectoryRecord | null> => PROJECT),
    remove: vi.fn(async () => {}),
  };
  const itx = {
    capabilityHost: { processor: { waitUntilProcessed: waitUntilProcessed("capability-host") } },
    email: { processor: { waitUntilProcessed: waitUntilProcessed("email") } },
    projectId: "prj_test",
    repo: { processor: { waitUntilProcessed: waitUntilProcessed("repo") } },
    scheduler: { processor: { waitUntilProcessed: waitUntilProcessed("scheduler") } },
    workers: {
      get: (ref: unknown, dispatch: { buildBudgetMs?: number; flattenNestedPaths?: boolean }) => {
        expect(ref).toEqual(defaultProjectWorkerRef());
        workerReadinessDispatches.push(dispatch);
        return {
          invokeCapability: async (input: { args?: unknown[]; path: string[] }) => {
            expect(input).toEqual({ args: [], path: ["__iteratePlatformReady"] });
            const call = workerReadinessCalls;
            const result = options.workerReadinessResults?.[call];
            workerReadinessCalls += 1;
            const advanceMs = options.workerReadinessAdvanceMs?.[call] ?? 0;
            clockBox.advance(Math.min(advanceMs, dispatch.buildBudgetMs ?? advanceMs));
            if (result instanceof Error) throw result;
            return result ?? true;
          },
        };
      },
    },
  } as unknown as ProjectRpcTarget;
  const Processor = options.processorClass ?? ProjectProcessor;
  const harness = makeProcessorHarness<ProjectProcessorContract>({
    path: "/",
    ...(options.substrate === undefined ? {} : { substrate: options.substrate }),
    createProcessor: (deps) =>
      new Processor({
        ...deps,
        // Readiness retries use the real bounded-time algorithm without
        // making the unit suite wait: each sleep advances this harness's
        // virtual clock by the requested amount.
        sleep: async (ms) => {
          clockBox.advance(ms);
          await Promise.resolve();
        },
        itx,
        customDomains,
      }),
  });
  clockBox.advance = (ms) => {
    harness.clock.now += ms;
  };
  // Join the harness stream into a network so the saga's cross-stream appends
  // (stream.at(path).append) land on observable sibling streams.
  const network = new MemoryStreamNetwork(() => harness.clock.now);
  network.streams.set("/", harness.stream);
  harness.stream.network = network;
  return {
    ...harness,
    network,
    customDomains,
    siblingWaits,
    siblingWaitStarted,
    workerReadinessCalls: () => workerReadinessCalls,
    workerReadinessDispatches,
  };
}

// =============================================================================
// Bootstrap
// =============================================================================

describe("ProjectProcessor bootstrap", () => {
  it("births each required sibling processor explicitly and waits for every birth within the shrinking barrier budget", async () => {
    const h = makeProjectHarness({
      clockAdvanceBySibling: { "capability-host": 10_000, scheduler: 5_000, repo: 5_000 },
    });

    await h.stream.append(
      ...projectCreationEvents({ projectId: "prj_test", payload: PROJECT_CREATED.payload }),
    );
    await h.settle();

    expect(h.network.eventsAt("/").map((event) => event.type)).toEqual([
      "events.iterate.com/project/created",
      "events.iterate.com/notification/created",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/capability-host/created",
      "events.iterate.com/stream/subscription-configured",
    ]);
    expect(h.network.eventsAt("/scheduler/primary").map((event) => event.type)).toEqual([
      "events.iterate.com/scheduler/created",
      "events.iterate.com/stream/subscription-configured",
    ]);
    expect(h.network.eventsAt("/repos/config").map((event) => event.type)).toEqual([
      "events.iterate.com/repos/create-requested",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
    ]);
    expect(h.network.eventsAt("/repos/config")[2]).toMatchObject({
      payload: {
        subscriptionKey: "project-config-to-root",
        receiver: {
          action: "copy-to-stream",
          receivingStreamPath: "/",
          delivery: { start: "now" },
        },
      },
    });
    expect(h.network.eventsAt("/integrations/email").map((event) => event.type)).toEqual([
      "events.iterate.com/email/created",
      "events.iterate.com/email/sender-allowed",
      "events.iterate.com/stream/subscription-configured",
    ]);

    // The frame waited for each sibling to reduce its complete birth batch
    // (offset = the batch's last event), against ONE shared shrinking budget:
    // 75s total, minus the 10s + 5s + 5s the earlier waits consumed.
    expect(h.siblingWaits).toEqual([
      { offset: 6, processor: "capability-host", timeoutMs: 75_000 },
      { offset: 2, processor: "scheduler", timeoutMs: 65_000 },
      { offset: 3, processor: "repo", timeoutMs: 60_000 },
      { offset: 3, processor: "email", timeoutMs: 55_000 },
    ]);

    expect(h.state()).toMatchObject({
      birthCertificate: PROJECT_CREATED.payload,
      onboardingActive: true,
      ready: false,
      notificationReady: true,
    });
  });

  it("does not finish the birth frame until every sibling processor has reduced its batch", async () => {
    let releaseEmail = () => {};
    const emailBarrier = new Promise<void>((resolve) => {
      releaseEmail = resolve;
    });
    const h = makeProjectHarness({ siblingWaitBarriers: { email: emailBarrier } });

    await h.stream.append(PROJECT_CREATED);
    let settled = false;
    const settling = h.settle().then(() => {
      settled = true;
    });

    // All four waits started in order, and the frame is still held open on
    // the parked email wait.
    await h.siblingWaitStarted.email;
    expect(h.siblingWaits.map((wait) => wait.processor)).toEqual([
      "capability-host",
      "scheduler",
      "repo",
      "email",
    ]);
    expect(settled).toBe(false);

    releaseEmail();
    await settling;
    expect(settled).toBe(true);
  });

  it("ignores a second project birth certificate during reduction", async () => {
    const h = makeProjectHarness();
    await h.play(["append", PROJECT_CREATED]);
    await h.play(["append", PROJECT_CREATED]);
    expect(h.state().birthCertificate).toEqual(PROJECT_CREATED.payload);
  });

  it.each([
    {
      error: Object.assign(new Error("coordinator still owns the build"), {
        name: "WorkerBuildInProgressError",
      }),
      outcome: "worker_build_in_progress",
    },
    {
      error: Object.assign(new Error("config repo is still materializing"), {
        name: "RepoNotSeededError",
      }),
      outcome: "repo_not_seeded",
    },
    {
      error: Object.assign(new Error("incarnation reset during dispatch"), {
        retryable: true,
      }),
      outcome: "durable_object_unavailable",
    },
  ])("waits through classified $outcome before marking the project ready", async (fixture) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const h = makeProjectHarness({
        workerReadinessResults: [fixture.error, true],
      });
      await h.play(["append", PROJECT_CREATED], ["append", CONFIG_REPO_READY]);

      expect(h.events("events.iterate.com/project/ready")).toHaveLength(1);
      expect(h.workerReadinessCalls()).toBe(2);
      expect(h.workerReadinessDispatches).toEqual([
        { buildBudgetMs: 5_000, flattenNestedPaths: true },
        { buildBudgetMs: 5_000, flattenNestedPaths: true },
      ]);
      expect(h.state().ready).toBe(true);
      expect(info).toHaveBeenCalledWith("default project worker readiness converged", {
        attempts: 2,
        projectId: "prj_test",
        transientOutcomes: { [fixture.outcome]: 1 },
        waitedMs: 500,
      });
    } finally {
      info.mockRestore();
    }
  });

  it("fails an unclassified worker error immediately with its identity preserved", async () => {
    const h = makeProjectHarness({
      workerReadinessResults: [
        Object.assign(new Error("customer module initialization exploded"), {
          name: "CustomerModuleError",
        }),
      ],
    });

    const failure = h.play(["append", PROJECT_CREATED], ["append", CONFIG_REPO_READY]);

    await expect(failure).rejects.toSatisfy((error: unknown) => {
      const messages = errorCauseMessages(error);
      return (
        messages.includes(
          "Error: Default project worker readiness handshake failed terminally on attempt 1: " +
            "CustomerModuleError: customer module initialization exploded",
        ) && messages.includes("CustomerModuleError: customer module initialization exploded")
      );
    });
    expect(h.workerReadinessCalls()).toBe(1);
    expect(h.events("events.iterate.com/project/ready")).toHaveLength(0);
  });

  it("rejects an invalid platform acknowledgement without retrying it", async () => {
    const h = makeProjectHarness({ workerReadinessResults: [false] });

    const failure = h.play(["append", PROJECT_CREATED], ["append", CONFIG_REPO_READY]);

    await expect(failure).rejects.toSatisfy((error: unknown) =>
      errorCauseMessages(error).includes(
        "Error: Default project worker readiness handshake violated its protocol on attempt 1: " +
          "expected true, received false (boolean)",
      ),
    );
    expect(h.workerReadinessCalls()).toBe(1);
    expect(h.events("events.iterate.com/project/ready")).toHaveLength(0);
  });

  it("bounds classified readiness recovery and reports every observed outcome", async () => {
    const building = Object.assign(new Error("coordinator still owns the build"), {
      name: "WorkerBuildInProgressError",
    });
    const h = makeProjectHarness({
      workerReadinessResults: Array.from({ length: 200 }, () => building),
      workerReadinessAdvanceMs: Array.from({ length: 200 }, () => 4_000),
    });

    const failure = h.play(["append", PROJECT_CREATED], ["append", CONFIG_REPO_READY]);

    await expect(failure).rejects.toSatisfy((error: unknown) =>
      errorCauseMessages(error).some(
        (message) =>
          message ===
          "Error: Default project worker did not become ready within 60000ms after 14 attempts; " +
            "transient outcomes: worker_build_in_progress=14; last error: " +
            "WorkerBuildInProgressError: coordinator still owns the build",
      ),
    );
    expect(h.workerReadinessCalls()).toBe(14);
    expect(h.workerReadinessDispatches.at(-1)).toEqual({
      buildBudgetMs: 1_500,
      flattenNestedPaths: true,
    });
    expect(h.events("events.iterate.com/project/ready")).toHaveLength(0);
  });
});

// =============================================================================
// Catalogs
// =============================================================================

describe("ProjectProcessor catalogs", () => {
  it("catalogs physical paths and received domain objects without reducing agent collection facts", async () => {
    const h = makeProjectHarness();
    await h.play(
      ["append", PROJECT_CREATED],
      [
        "append",
        {
          type: "events.iterate.com/stream/child-stream-created",
          payload: { childPath: "/agents/slack" },
        },
        {
          type: "events.iterate.com/agent/created",
          payload: {},
          source: {
            copiedFrom: [
              {
                subscriptionKey: "agent-catalog",
                streamId: "11111111-1111-4111-8111-111111111111",
                streamCreatedAt: new Date(1).toISOString(),
                cursorChangedAtSourceOffset: 1,
                createdAt: new Date(3).toISOString(),
                offset: 1,
                path: "/agents/slack/main/C123/ts-1",
                projectId: "prj_test",
                type: "events.iterate.com/agent/created",
              },
            ],
          },
        },
        {
          type: "events.iterate.com/repos/created",
          payload: {
            request: { type: "empty" },
            artifactName: "prj_test--L3JlcG9zL3NpZGUtcmVwbw",
            defaultBranch: "main",
            remote: "https://example.artifacts.cloudflare.net/git/ns/side.git",
          },
          source: {
            copiedFrom: [
              {
                subscriptionKey: "repo-catalog",
                streamId: "11111111-1111-4111-8111-111111111111",
                streamCreatedAt: new Date(1).toISOString(),
                cursorChangedAtSourceOffset: 1,
                createdAt: new Date(4).toISOString(),
                offset: 1,
                path: "/repos/side-repo",
                projectId: "prj_test",
                type: "events.iterate.com/repos/created",
              },
            ],
          },
        },
      ],
    );

    expect(h.state()).toMatchObject({
      streams: [{ path: "/agents/slack" }],
      repos: [{ path: "/repos/side-repo" }],
    });
    expect(h.state()).not.toHaveProperty("agents");
    expect(h.network.eventsAt("/agents/slack")).toEqual([]);
  });
});

// =============================================================================
// Custom domains
// =============================================================================

describe("ProjectProcessor custom domains", () => {
  it("provisions and catalogs a Cloudflare hostname", async () => {
    const h = makeProjectHarness();
    await h.play(
      ["append", PROJECT_CREATED],
      [
        "append",
        {
          type: "events.iterate.com/project/custom-domain-add-requested",
          payload: { hostname: "garple.com" },
        },
      ],
    );

    expect(h.customDomains.ensure).toHaveBeenCalledWith({
      hostname: "garple.com",
      project: PROJECT,
    });
    expect(h.events("events.iterate.com/project/custom-domain-configured")).toMatchObject([
      {
        payload: {
          hostname: "garple.com",
          kind: "cloudflare",
        },
      },
    ]);
    expect(h.state().customDomains).toEqual([{ hostname: "garple.com", kind: "cloudflare" }]);
  });

  it("records provisioning failure without inventing configured state", async () => {
    const h = makeProjectHarness();
    h.customDomains.ensure.mockRejectedValueOnce(new Error("Cloudflare is unavailable"));
    await h.play(
      ["append", PROJECT_CREATED],
      [
        "append",
        {
          type: "events.iterate.com/project/custom-domain-add-requested",
          payload: { hostname: "garple.com" },
        },
      ],
    );

    expect(h.events("events.iterate.com/project/custom-domain-provision-failed")).toMatchObject([
      { payload: { error: "Cloudflare is unavailable", hostname: "garple.com" } },
    ]);
    expect(h.state().customDomains).toEqual([]);
  });

  it("removes Cloudflare hostnames while direct hostnames remain operator-managed", async () => {
    const h = makeProjectHarness();
    await h.play(
      ["append", PROJECT_CREATED],
      [
        "append",
        {
          type: "events.iterate.com/project/custom-domain-configured",
          payload: { hostname: "garple.com", kind: "cloudflare" },
        },
        {
          type: "events.iterate.com/project/custom-domain-configured",
          payload: { hostname: "iterate.com", kind: "direct" },
        },
      ],
      [
        "append",
        {
          type: "events.iterate.com/project/custom-domain-add-requested",
          payload: { hostname: "iterate.com" },
        },
      ],
      [
        "append",
        {
          type: "events.iterate.com/project/custom-domain-remove-requested",
          payload: { hostname: "iterate.com" },
        },
      ],
      [
        "append",
        {
          type: "events.iterate.com/project/custom-domain-remove-requested",
          payload: { hostname: "garple.com" },
        },
      ],
    );

    expect(h.customDomains.ensure).not.toHaveBeenCalled();
    expect(h.customDomains.remove).toHaveBeenCalledWith({
      hostname: "garple.com",
      project: PROJECT,
    });
    expect(h.events("events.iterate.com/project/custom-domain-removed")).toMatchObject([
      { payload: { hostname: "garple.com" } },
    ]);
    expect(h.state().customDomains).toEqual([{ hostname: "iterate.com", kind: "direct" }]);
  });
});

// =============================================================================
// Egress policy reductions
// =============================================================================

describe("ProjectProcessor egress policy", () => {
  it("replaces egress rules wholesale, deduplicates key enrollment, and marks revocations", async () => {
    const h = makeProjectHarness();
    await h.play(
      ["append", PROJECT_CREATED],
      [
        "append",
        {
          type: "events.iterate.com/project/egress-rules-configured",
          payload: {
            rules: [{ ruleKey: "stripe", match: { hosts: ["api.stripe.com"] }, verdict: "hold" }],
          },
        },
        {
          type: "events.iterate.com/project/egress-rules-configured",
          payload: { rules: [{ ruleKey: "deny-all", verdict: "deny" }] },
        },
        {
          type: "events.iterate.com/project/human-approval-key-added",
          payload: { keyId: "key-1", publicKey: "AAAA", label: "laptop" },
        },
        {
          type: "events.iterate.com/project/human-approval-key-added",
          payload: { keyId: "key-1", publicKey: "BBBB" },
        },
        {
          type: "events.iterate.com/project/human-approval-key-revoked",
          payload: { keyId: "key-1" },
        },
      ],
    );

    // Wholesale replacement: only the second rule list survives, with the
    // schema's timeout default filled in.
    expect(h.state().egressRules).toEqual([
      {
        ruleKey: "deny-all",
        description: "",
        match: {},
        verdict: "deny",
        approvalTimeoutMs: 600_000,
      },
    ]);
    // Re-enrolling an existing keyId is a no-op (the first enrollment's
    // public key stands); the revocation stamps revokedAt.
    expect(h.state().humanApprovalKeys).toMatchObject([
      { keyId: "key-1", publicKey: "AAAA", label: "laptop", revokedAt: expect.any(String) },
    ]);
  });
});

// =============================================================================
// Full replay
// =============================================================================

describe("ProjectProcessor full replay", () => {
  it("a full replay (fresh cursor over the same stream) redelivers every event without wedging or duplicating", async () => {
    // The harshest at-least-once redelivery: a fresh progress store over the
    // SAME stream replays every event, so every blocked per-event append (the
    // whole birth saga, the ready fact, the custom-domain configuration)
    // re-runs. Each must produce a body IDENTICAL to the committed one so the
    // idempotency keys dedupe — a same-key-different-body append would be
    // REJECTED and wedge the frame.
    const h = makeProjectHarness();
    await h.stream.append(
      ...projectCreationEvents({ projectId: "prj_test", payload: PROJECT_CREATED.payload }),
    );
    await h.settle();
    await h.play(
      ["append", CONFIG_REPO_READY],
      [
        "append",
        {
          type: "events.iterate.com/project/custom-domain-add-requested",
          payload: { hostname: "garple.com" },
        },
      ],
    );
    const committedOffsets = h.events().map((row) => row.offset);
    expect(h.state()).toMatchObject({ ready: true, notificationReady: true });

    const replay = makeProjectHarness({
      substrate: {
        clock: h.clock,
        stream: h.stream,
        progress: makeMemoryProgressStore(ProjectProcessorContract),
      },
    });
    await replay.settle(); // replays the whole stream; a wedge would throw here

    expect(replay.events().map((row) => row.offset)).toEqual(committedOffsets);
    expect(replay.state()).toMatchObject({
      ready: true,
      notificationReady: true,
      customDomains: [{ hostname: "garple.com", kind: "cloudflare" }],
    });
  });
});
