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
import { workerBuildingResponse } from "../workers/worker-fetch-dispatch.ts";
import { projectCreationEvents } from "./project-defaults.ts";
import type {
  ProjectProcessorContract,
  ProjectCustomDomainCloudflareSnapshot,
} from "./project-processor-contract.ts";
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

/** The cross-posted copy of the config repo's terminal creation certificate,
 * as the `cross-post:/` rule lands it on the project root. */
const CONFIG_REPO_READY = {
  type: "events.iterate.com/repos/created",
  payload: {
    request: { type: "empty" },
    artifactName: "prj_test--L3JlcG9zL2NvbmZpZw",
    defaultBranch: "main",
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

function customDomainSnapshot(
  input: Partial<ProjectCustomDomainCloudflareSnapshot> = {},
): ProjectCustomDomainCloudflareSnapshot {
  return {
    cloudflareHostnameId: "custom-hostname-1",
    error: null,
    hostname: "garple.com",
    hostnameStatus: "active",
    ownershipVerification: null,
    sslStatus: "active",
    status: "active",
    validationRecords: [],
    wildcard: true,
    ...input,
  };
}

type SiblingName = "capability-host" | "scheduler" | "repo" | "email";
const SIBLINGS = ["capability-host", "scheduler", "repo", "email"] as const;

/** The generic harness plus the project's fakes (itx sibling facades, worker
 * probe, custom-domain provisioner), wired in createProcessor. */
function makeProjectHarness(
  options: {
    substrate?: HarnessSubstrate;
    /** Served to successive worker readiness probes; a 204 after the list runs out. */
    workerResponses?: Response[];
    /** Parks the named sibling's waitUntilProcessed until the promise resolves. */
    siblingWaitBarriers?: Partial<Record<SiblingName, Promise<void>>>;
    /** Advance the virtual clock by this much inside the named sibling's wait,
     * to observe the shrinking birth-barrier budget. */
    clockAdvanceBySibling?: Partial<Record<SiblingName, number>>;
    processorClass?: typeof ProjectProcessor;
  } = {},
) {
  let workerFetchCalls = 0;
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
    ensure: vi.fn(async () =>
      customDomainSnapshot({
        hostnameStatus: "pending",
        sslStatus: "pending_validation",
        status: "pending_validation",
      }),
    ),
    readProject: vi.fn(async (): Promise<ProjectDirectoryRecord | null> => PROJECT),
    refresh: vi.fn(async () => customDomainSnapshot()),
    remove: vi.fn(async () => {}),
  };
  const itx = {
    capabilityHost: { processor: { waitUntilProcessed: waitUntilProcessed("capability-host") } },
    email: { processor: { waitUntilProcessed: waitUntilProcessed("email") } },
    projectId: "prj_test",
    repo: { processor: { waitUntilProcessed: waitUntilProcessed("repo") } },
    scheduler: { processor: { waitUntilProcessed: waitUntilProcessed("scheduler") } },
    worker: {
      fetch: async () => {
        const response = options.workerResponses?.[workerFetchCalls];
        workerFetchCalls += 1;
        return response ?? new Response(null, { status: 204 });
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
        // The worker probe's retry pause: immediate but still async. The
        // project processor is not time-driven, so nothing here needs the
        // virtual clock's advanceTime choreography.
        sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
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
    workerFetchCalls: () => workerFetchCalls,
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
        deliver: "new",
        subscriptionKey: "cross-post:/",
      },
    });
    expect(h.network.eventsAt("/integrations/email").map((event) => event.type)).toEqual([
      "events.iterate.com/email/created",
      "events.iterate.com/email/sender-allowed",
      "events.iterate.com/stream/subscription-configured",
    ]);

    // The frame waited for each sibling to reduce its complete birth batch
    // (offset = the batch's last event), against ONE shared shrinking budget:
    // 60s total, minus the 10s + 5s + 5s the earlier waits consumed.
    expect(h.siblingWaits).toEqual([
      { offset: 6, processor: "capability-host", timeoutMs: 60_000 },
      { offset: 2, processor: "scheduler", timeoutMs: 50_000 },
      { offset: 3, processor: "repo", timeoutMs: 45_000 },
      { offset: 3, processor: "email", timeoutMs: 40_000 },
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

  it("waits through a cold-build probe response before marking the project ready", async () => {
    const h = makeProjectHarness({
      workerResponses: [
        workerBuildingResponse(),
        Response.json({ app: "hello", projectId: "prj_test" }),
      ],
    });
    await h.play(["append", PROJECT_CREATED], ["append", CONFIG_REPO_READY]);

    expect(h.events("events.iterate.com/project/ready")).toHaveLength(1);
    expect(h.workerFetchCalls()).toBe(2);
    expect(h.state().ready).toBe(true);
  });
});

// =============================================================================
// Catalogs
// =============================================================================

describe("ProjectProcessor catalogs", () => {
  it("catalogs physical paths and cross-posted domain objects without reducing agent collection facts", async () => {
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
        {
          type: "events.iterate.com/repos/created",
          payload: {
            request: { type: "empty" },
            artifactName: "prj_test--L3JlcG9zL3NpZGUtcmVwbw",
            defaultBranch: "main",
            remote: "https://example.artifacts.cloudflare.net/git/ns/side.git",
          },
          source: {
            crossPostedFrom: [
              {
                subscriptionKey: "repo-catalog",
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
  it("provisions an add request and reduces the observed Cloudflare status onto state", async () => {
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
    expect(h.events("events.iterate.com/project/custom-domain-cloudflare-observed")).toMatchObject([
      {
        payload: {
          cloudflareHostnameId: "custom-hostname-1",
          hostname: "garple.com",
          status: "pending_validation",
          wildcard: true,
        },
      },
    ]);
    // The add request reduced to `requested` first, then the observation
    // replaced it with the Cloudflare snapshot.
    expect(h.state().customDomains).toMatchObject([
      {
        cloudflareHostnameId: "custom-hostname-1",
        hostname: "garple.com",
        kind: "cloudflare",
        status: "pending_validation",
        wildcard: true,
      },
    ]);
  });

  it("falls back to a directory record built from state when the project directory has no entry", async () => {
    const h = makeProjectHarness();
    h.customDomains.readProject.mockResolvedValueOnce(null);
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
      project: { id: "prj_test", slug: "demo", organizationId: null, name: "demo" },
    });
  });

  it("preserves the last Cloudflare snapshot when a refresh fails", async () => {
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
      // A later observation saw the domain go fully active.
      [
        "append",
        {
          type: "events.iterate.com/project/custom-domain-cloudflare-observed",
          payload: customDomainSnapshot(),
        },
      ],
    );
    expect(h.state().customDomains).toMatchObject([{ hostname: "garple.com", status: "active" }]);

    h.customDomains.refresh.mockRejectedValueOnce(new Error("Cloudflare is unavailable"));
    await h.play([
      "append",
      {
        type: "events.iterate.com/project/custom-domain-refresh-requested",
        payload: { hostname: "garple.com" },
      },
    ]);

    expect(h.customDomains.refresh).toHaveBeenCalledWith({
      cloudflareHostnameId: "custom-hostname-1",
      hostname: "garple.com",
      project: PROJECT,
    });
    expect(h.events("events.iterate.com/project/custom-domain-provision-failed")).toMatchObject([
      { payload: { error: "Cloudflare is unavailable", hostname: "garple.com" } },
    ]);
    // The failure recorded the error but kept the active snapshot: an active
    // domain must not drop off routing because one re-poll failed.
    expect(h.state().customDomains).toMatchObject([
      {
        cloudflareHostnameId: "custom-hostname-1",
        error: "Cloudflare is unavailable",
        hostname: "garple.com",
        status: "active",
      },
    ]);
  });

  it("removes a domain through the provisioner and drops it from state; a failed removal records the error instead", async () => {
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

    // First removal attempt fails at Cloudflare: the failure is recorded and
    // the domain stays (marked removing by the request's own reduction).
    h.customDomains.remove.mockRejectedValueOnce(new Error("Cloudflare is unavailable"));
    await h.play([
      "append",
      {
        type: "events.iterate.com/project/custom-domain-remove-requested",
        payload: { hostname: "garple.com" },
      },
    ]);
    expect(h.events("events.iterate.com/project/custom-domain-provision-failed")).toMatchObject([
      { payload: { error: "Cloudflare is unavailable", hostname: "garple.com" } },
    ]);
    expect(h.state().customDomains).toMatchObject([{ hostname: "garple.com", status: "failed" }]);

    // The retried removal succeeds and the domain leaves state entirely.
    await h.play([
      "append",
      {
        type: "events.iterate.com/project/custom-domain-remove-requested",
        payload: { hostname: "garple.com" },
      },
    ]);
    expect(h.customDomains.remove).toHaveBeenCalledWith({
      cloudflareHostnameId: "custom-hostname-1",
      hostname: "garple.com",
      project: PROJECT,
    });
    expect(h.events("events.iterate.com/project/custom-domain-removed")).toMatchObject([
      { payload: { hostname: "garple.com" } },
    ]);
    expect(h.state().customDomains).toEqual([]);
  });

  it("records a failure for a remove request naming a domain the project does not have", async () => {
    const h = makeProjectHarness();
    await h.play(
      ["append", PROJECT_CREATED],
      [
        "append",
        {
          type: "events.iterate.com/project/custom-domain-remove-requested",
          payload: { hostname: "nobody.example.com" },
        },
      ],
    );

    expect(h.customDomains.remove).not.toHaveBeenCalled();
    expect(h.events("events.iterate.com/project/custom-domain-provision-failed")).toMatchObject([
      {
        payload: {
          error: 'Custom domain "nobody.example.com" is not configured on this project.',
          hostname: "nobody.example.com",
        },
      },
    ]);
  });
});

// =============================================================================
// Direct custom domains
// =============================================================================

describe("ProjectProcessor direct custom domains", () => {
  it("reduces an operator's direct-observed fact to an active direct entry without touching the provisioner", async () => {
    const h = makeProjectHarness();
    await h.play(
      ["append", PROJECT_CREATED],
      [
        "append",
        {
          type: "events.iterate.com/project/custom-domain-direct-observed",
          payload: { hostname: "iterate.com" },
        },
        {
          type: "events.iterate.com/project/custom-domain-direct-observed",
          payload: { hostname: "www.iterate.com" },
        },
      ],
    );

    expect(h.state().customDomains).toMatchObject([
      {
        cloudflareHostnameId: null,
        error: null,
        hostname: "iterate.com",
        kind: "direct",
        status: "active",
        validationRecords: [],
        wildcard: false,
      },
      { hostname: "www.iterate.com", kind: "direct", status: "active" },
    ]);
    // A pure reduction: no Cloudflare call, no observed/failed follow-up.
    expect(h.customDomains.ensure).not.toHaveBeenCalled();
    expect(h.customDomains.refresh).not.toHaveBeenCalled();
    expect(h.customDomains.remove).not.toHaveBeenCalled();
    expect(h.events("events.iterate.com/project/custom-domain-cloudflare-observed")).toEqual([]);
    expect(h.events("events.iterate.com/project/custom-domain-provision-failed")).toEqual([]);
  });

  it("keeps a direct entry when a stray Cloudflare snapshot names the same hostname", async () => {
    const h = makeProjectHarness();
    await h.play(
      ["append", PROJECT_CREATED],
      [
        "append",
        {
          type: "events.iterate.com/project/custom-domain-direct-observed",
          payload: { hostname: "iterate.com" },
        },
      ],
    );
    const before = h.state().customDomains;

    await h.play([
      "append",
      {
        type: "events.iterate.com/project/custom-domain-cloudflare-observed",
        payload: customDomainSnapshot({ hostname: "iterate.com" }),
      },
    ]);

    // Direct outranks any snapshot: lifecycle fields (and the UI's
    // refresh/remove affordances) must not resurrect.
    expect(h.state().customDomains).toEqual(before);
  });

  it("keeps add/refresh/remove requests for a direct hostname away from the provisioner and the routing registration", async () => {
    // The trap this guards: ensure() for an already-live direct registration
    // creates a pending Cloudflare-for-SaaS hostname, and the non-active
    // snapshot's reconciliation DELETES the live KV registration — taking the
    // domain down. Requests naming a direct hostname must be inert.
    const h = makeProjectHarness();
    await h.play(
      ["append", PROJECT_CREATED],
      [
        "append",
        {
          type: "events.iterate.com/project/custom-domain-direct-observed",
          payload: { hostname: "iterate.com" },
        },
      ],
    );
    const before = h.state().customDomains;

    await h.play(
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
          type: "events.iterate.com/project/custom-domain-refresh-requested",
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
    );

    expect(h.customDomains.ensure).not.toHaveBeenCalled();
    expect(h.customDomains.refresh).not.toHaveBeenCalled();
    expect(h.customDomains.remove).not.toHaveBeenCalled();
    expect(h.events("events.iterate.com/project/custom-domain-cloudflare-observed")).toEqual([]);
    expect(h.events("events.iterate.com/project/custom-domain-provision-failed")).toEqual([]);
    expect(h.events("events.iterate.com/project/custom-domain-removed")).toEqual([]);
    // Not flipped to requested/removing: the entry stays exactly as observed.
    expect(h.state().customDomains).toEqual(before);
  });

  it("retires a direct entry through an operator-appended custom-domain-removed, a pure reduction", async () => {
    const h = makeProjectHarness();
    await h.play(
      ["append", PROJECT_CREATED],
      [
        "append",
        {
          type: "events.iterate.com/project/custom-domain-direct-observed",
          payload: { hostname: "iterate.com" },
        },
      ],
      [
        "append",
        {
          type: "events.iterate.com/project/custom-domain-removed",
          payload: { hostname: "iterate.com" },
        },
      ],
    );

    expect(h.state().customDomains).toEqual([]);
    expect(h.customDomains.remove).not.toHaveBeenCalled();
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
    // whole birth saga, the ready fact, the custom-domain observations)
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
      substrate: { clock: h.clock, stream: h.stream, progress: makeMemoryProgressStore() },
    });
    await replay.settle(); // replays the whole stream; a wedge would throw here

    expect(replay.events().map((row) => row.offset)).toEqual(committedOffsets);
    expect(replay.state()).toMatchObject({
      ready: true,
      notificationReady: true,
      customDomains: [{ hostname: "garple.com", status: "pending_validation" }],
    });
  });
});
