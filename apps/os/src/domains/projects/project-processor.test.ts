import { describe, expect, it } from "vitest";
import { makeMemoryProgressStore } from "iterate/processors/testing";
import {
  STREAM_DELIVERY_REJECTED_MESSAGE_PREFIX,
  STREAM_WAIT_TIMEOUT_MESSAGE_PREFIX,
} from "../streams/stream-unavailable.ts";
import { WorkerBuildFailedError } from "../workers/artifact-store.ts";
import { workerBuildingResponse } from "../workers/worker-fetch-dispatch.ts";
import { projectCreationEvents } from "./project-defaults.ts";
import {
  CONFIG_REPO_CREATED,
  CONFIG_REPO_CREATE_FAILED,
  PROJECT,
  PROJECT_CREATED,
  PROJECT_CREATE_REQUESTED,
  customDomainSnapshot,
  makeProjectHarness,
  type ProjectEventInput,
} from "./project-processor-test-harness.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";

// =============================================================================
// Bootstrap
// =============================================================================

describe("ProjectProcessor bootstrap", () => {
  it("births each required sibling processor explicitly and waits for every birth within the shrinking barrier budget", async () => {
    const h = makeProjectHarness({
      clockAdvanceBySibling: { "capability-host": 10_000, scheduler: 5_000, repo: 5_000 },
    });

    await h.stream.append(
      ...projectCreationEvents({
        projectId: "prj_test",
        payload: PROJECT_CREATE_REQUESTED.payload,
      }),
    );
    await h.settle();

    expect(h.network.eventsAt("/").map((event) => event.type)).toEqual([
      "events.iterate.com/project/create-requested",
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
    // 75s total, minus the 10s + 5s + 5s the earlier waits consumed.
    expect(h.siblingWaits).toEqual([
      { offset: 6, processor: "capability-host", timeoutMs: 75_000 },
      { offset: 2, processor: "scheduler", timeoutMs: 65_000 },
      { offset: 3, processor: "repo", timeoutMs: 60_000 },
      { offset: 3, processor: "email", timeoutMs: 55_000 },
    ]);

    expect(h.state()).toMatchObject({
      createRequest: PROJECT_CREATE_REQUESTED.payload,
      birthCertificate: null,
      onboardingActive: true,
      notificationReady: true,
    });
  });

  it("does not finish the birth frame until every sibling processor has reduced its batch", async () => {
    let releaseEmail = () => {};
    const emailBarrier = new Promise<void>((resolve) => {
      releaseEmail = resolve;
    });
    const h = makeProjectHarness({ siblingWaitBarriers: { email: emailBarrier } });

    await h.stream.append(PROJECT_CREATE_REQUESTED);
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
    await h.play(["append", PROJECT_CREATE_REQUESTED, PROJECT_CREATED]);
    await h.play(["append", PROJECT_CREATED]);
    expect(h.state().birthCertificate).toEqual(PROJECT_CREATED.payload);
  });

  it("does not reopen onboarding when project/created follows an early completion", async () => {
    const h = makeProjectHarness();
    await h.play([
      "append",
      PROJECT_CREATE_REQUESTED,
      {
        type: "events.iterate.com/project/onboarding-completed",
        payload: { agentPath: "/agents/onboarding" },
      },
      PROJECT_CREATED,
    ]);

    expect(h.state()).toMatchObject({
      birthCertificate: PROJECT_CREATED.payload,
      onboardingActive: false,
      onboardingCompletedAt: expect.any(String),
    });
  });

  it("only the first project/create-requested event can drive sibling creation", async () => {
    const h = makeProjectHarness();
    await h.play(["append", PROJECT_CREATE_REQUESTED]);
    const configRepoEventCount = h.network.eventsAt("/repos/config").length;

    await h.play([
      "append",
      {
        ...PROJECT_CREATE_REQUESTED,
        payload: {
          config: {
            ...PROJECT_CREATE_REQUESTED.payload.config,
            creatorEmail: "different@example.com",
          },
        },
      },
    ]);

    expect(h.network.eventsAt("/repos/config")).toHaveLength(configRepoEventCount);
  });

  it("waits through a cold build and fenced create-requested delivery before appending project/created", async () => {
    const h = makeProjectHarness({
      workerOutcomes: [
        workerBuildingResponse(),
        Response.json({ app: "hello", projectId: "prj_test" }),
      ],
    });
    await h.play(["append", PROJECT_CREATE_REQUESTED], ["append", CONFIG_REPO_CREATED]);

    expect(h.events("events.iterate.com/project/created")).toHaveLength(1);
    expect(h.workerFetchCalls()).toBe(2);
    expect(
      h
        .events("events.iterate.com/stream/subscription-configured")
        .filter((event) => event.payload.subscriptionKey === "project-worker"),
    ).toMatchObject([
      {
        idempotencyKey: "project-worker-creation-subscription:prj_test",
        payload: {
          deliver: { afterOffset: 0 },
          onPoison: "park",
          selector: {
            eventTypes: ["events.iterate.com/project/create-requested"],
            condition: "offset = 1",
          },
        },
      },
      {
        idempotencyKey: "project-worker-subscription:prj_test",
        payload: {
          deliver: { afterOffset: 1 },
          onPoison: "skip",
        },
      },
    ]);
    expect(h.subscriptionDeliveryWaits).toEqual([
      {
        configuredAtOffset: expect.any(Number),
        eventType: "events.iterate.com/project/create-requested",
        expression: ["processEventBatch"],
        subscriptionKey: "project-worker",
        targetOffset: 1,
        timeoutMs: 60_000,
      },
    ]);
    expect(h.state().birthCertificate).toEqual(PROJECT_CREATED.payload);
  });

  it("does not append project/created while the worker delivery fence is open", async () => {
    const delivery = Promise.withResolvers<void>();
    const h = makeProjectHarness({ subscriptionDeliveryBarrier: delivery.promise });
    await h.play(["append", PROJECT_CREATE_REQUESTED]);
    await h.stream.append(CONFIG_REPO_CREATED);
    const settling = h.settle();

    await h.subscriptionDeliveryWaitStarted;
    expect(h.events("events.iterate.com/project/created")).toEqual([]);

    delivery.resolve();
    await settling;
    expect(h.events("events.iterate.com/project/created")).toHaveLength(1);
  });

  it("terminalizes a project-worker delivery failure and removes the unusable subscription", async () => {
    const h = makeProjectHarness({
      subscriptionDeliveryErrors: [
        new Error(`${STREAM_DELIVERY_REJECTED_MESSAGE_PREFIX}subscription parked at offset 1`),
      ],
    });
    await h.play(["append", PROJECT_CREATE_REQUESTED], ["append", CONFIG_REPO_CREATED]);

    expect(h.events("events.iterate.com/project/created")).toEqual([]);
    expect(h.events("events.iterate.com/stream/subscription-removed")).toMatchObject([
      {
        idempotencyKey: "project-worker-subscription-removed:prj_test",
        payload: { subscriptionKey: "project-worker" },
      },
    ]);
    expect(h.events("events.iterate.com/project/create-failed")).toMatchObject([
      {
        idempotencyKey: "project/create-failed",
        payload: {
          createRequestedAtOffset: 1,
          error:
            "Default project worker bootstrap failed: stream-delivery-rejected: subscription parked at offset 1",
          request: PROJECT_CREATE_REQUESTED.payload,
        },
      },
    ]);
  });

  it("leaves an unclassified worker build failure open for durable redelivery", async () => {
    const h = makeProjectHarness({
      workerOutcomes: [new WorkerBuildFailedError("Expected ; but found is")],
      workerRetrySleep: async () => undefined,
    });
    await h.stream.append(PROJECT_CREATE_REQUESTED, CONFIG_REPO_CREATED);

    await expect(h.settle()).rejects.toThrow("Expected ; but found is");
    expect(h.workerFetchCalls()).toBe(1);
    expect(h.events("events.iterate.com/project/created")).toEqual([]);
    expect(h.events("events.iterate.com/project/create-failed")).toEqual([]);

    await h.settle();
    expect(h.workerFetchCalls()).toBe(2);
    expect(h.events("events.iterate.com/project/created")).toHaveLength(1);
  });

  it("leaves a transient worker dispatch failure open for durable redelivery", async () => {
    const h = makeProjectHarness({
      workerOutcomes: [new Error("temporary worker dispatch outage")],
    });
    await h.stream.append(PROJECT_CREATE_REQUESTED, CONFIG_REPO_CREATED);

    await expect(h.settle()).rejects.toThrow("temporary worker dispatch outage");
    expect(h.events("events.iterate.com/project/create-failed")).toEqual([]);
    expect(h.state().createFailure).toBeNull();

    await h.settle();
    expect(h.events("events.iterate.com/project/created")).toHaveLength(1);
  });

  it("leaves a delivery timeout open and completes on durable redelivery", async () => {
    const h = makeProjectHarness({
      subscriptionDeliveryErrors: [
        new Error(`${STREAM_WAIT_TIMEOUT_MESSAGE_PREFIX}temporary delivery timeout`),
      ],
    });
    await h.stream.append(PROJECT_CREATE_REQUESTED, CONFIG_REPO_CREATED);

    await expect(h.settle()).rejects.toThrow("temporary delivery timeout");
    expect(h.events("events.iterate.com/project/create-failed")).toEqual([]);
    expect(h.events("events.iterate.com/project/created")).toEqual([]);

    await h.settle();
    expect(h.subscriptionDeliveryWaits).toHaveLength(2);
    expect(h.events("events.iterate.com/project/created")).toHaveLength(1);
  });

  it("leaves a worker that is still building open and completes on durable redelivery", async () => {
    const h = makeProjectHarness({
      workerOutcomes: Array.from({ length: 20 }, () => workerBuildingResponse()),
      workerRetrySleep: async () => undefined,
    });
    await h.stream.append(PROJECT_CREATE_REQUESTED, CONFIG_REPO_CREATED);

    await expect(h.settle()).rejects.toMatchObject({ name: "WorkerBuildInProgressError" });
    expect(h.workerFetchCalls()).toBe(20);
    expect(h.events("events.iterate.com/project/create-failed")).toEqual([]);

    await h.settle();
    expect(h.workerFetchCalls()).toBe(21);
    expect(h.events("events.iterate.com/project/created")).toHaveLength(1);
  });

  it("treats any application response as proof that the worker built and loaded", async () => {
    const h = makeProjectHarness({
      workerOutcomes: [new Response("userspace route failed", { status: 500 })],
    });
    await h.play(["append", PROJECT_CREATE_REQUESTED], ["append", CONFIG_REPO_CREATED]);

    expect(h.workerFetchCalls()).toBe(1);
    expect(h.events("events.iterate.com/project/create-failed")).toEqual([]);
    expect(h.events("events.iterate.com/project/created")).toHaveLength(1);
  });

  it("settles a terminal config-repo failure as project/create-failed and closes the saga", async () => {
    const h = makeProjectHarness();
    await h.play(["append", PROJECT_CREATE_REQUESTED], ["append", CONFIG_REPO_CREATE_FAILED]);

    expect(h.events("events.iterate.com/project/create-failed")).toMatchObject([
      {
        idempotencyKey: "project/create-failed",
        payload: {
          createRequestedAtOffset: 1,
          error: "Config repo creation failed: The backing repository could not be created.",
          request: PROJECT_CREATE_REQUESTED.payload,
        },
      },
    ]);
    expect(h.workerFetchCalls()).toBe(0);
    expect(h.subscriptionDeliveryWaits).toEqual([]);
    expect(h.state()).toMatchObject({
      birthCertificate: null,
      createFailure: {
        createRequestedAtOffset: 1,
        error: "Config repo creation failed: The backing repository could not be created.",
        request: PROJECT_CREATE_REQUESTED.payload,
      },
    });

    await h.play(
      ["append", PROJECT_CREATED],
      [
        "append",
        {
          type: "events.iterate.com/project/custom-domain-add-requested",
          payload: { hostname: "after-failure.example.com" },
        },
      ],
    );
    expect(h.state().birthCertificate).toBeNull();
    expect(h.customDomains.ensure).not.toHaveBeenCalled();
  });

  it("reduces only a terminal fact that exactly settles the open creation request", async () => {
    const failure = {
      type: "events.iterate.com/project/create-failed",
      idempotencyKey: "project/create-failed",
      payload: {
        createRequestedAtOffset: 1,
        error: "not this request",
        request: PROJECT_CREATE_REQUESTED.payload,
      },
    } satisfies ProjectEventInput;
    const userspaceSource = {
      processor: {
        slug: ProjectProcessorContract.slug,
        version: ProjectProcessorContract.version,
        stream: { path: "/", projectId: "prj_test" },
        whileProcessing: { offset: 2, type: "events.iterate.com/repos/created" },
      },
    } as const;
    const crossPostSource = {
      ...PROJECT_CREATED.source,
      crossPostedFrom: [
        {
          subscriptionKey: "cross-post:/",
          createdAt: new Date(2).toISOString(),
          offset: 2,
          path: "/elsewhere",
          projectId: "prj_test",
          type: "events.iterate.com/project/created",
        },
      ],
    } satisfies NonNullable<ProjectEventInput["source"]>;

    for (const counterfeit of [
      { ...PROJECT_CREATED, source: undefined },
      { ...PROJECT_CREATED, source: userspaceSource },
      { ...PROJECT_CREATED, source: crossPostSource },
      failure,
      { ...failure, source: userspaceSource },
    ] satisfies ProjectEventInput[]) {
      const h = makeProjectHarness();
      await h.play(["append", PROJECT_CREATE_REQUESTED], ["append", counterfeit]);
      expect(h.state().birthCertificate).toBeNull();
      expect(h.state().createFailure).toBeNull();
    }

    for (const mismatched of [
      {
        ...PROJECT_CREATED,
        payload: { ...PROJECT_CREATED.payload, createRequestedAtOffset: 999 },
      },
      {
        ...PROJECT_CREATED,
        payload: {
          config: { ...PROJECT_CREATED.payload.config, slug: "different" },
          createRequestedAtOffset: 1,
        },
      },
      {
        ...failure,
        source: PROJECT_CREATED.source,
        payload: { ...failure.payload, createRequestedAtOffset: 999 },
      },
      {
        ...failure,
        source: PROJECT_CREATED.source,
        payload: {
          ...failure.payload,
          request: {
            config: { ...PROJECT_CREATE_REQUESTED.payload.config, slug: "different" },
          },
        },
      },
    ] satisfies ProjectEventInput[]) {
      const h = makeProjectHarness();
      await h.play(["append", PROJECT_CREATE_REQUESTED], ["append", mismatched]);
      expect(h.state().birthCertificate).toBeNull();
      expect(h.state().createFailure).toBeNull();
    }

    const h = makeProjectHarness();
    await h.play(["append", PROJECT_CREATE_REQUESTED], ["append", PROJECT_CREATED]);
    expect(h.state().birthCertificate).toEqual(PROJECT_CREATED.payload);
  });
});

// =============================================================================
// Catalogs
// =============================================================================

describe("ProjectProcessor catalogs", () => {
  it("catalogs physical paths and cross-posted domain objects without reducing agent collection facts", async () => {
    const h = makeProjectHarness();
    await h.play(
      ["append", PROJECT_CREATE_REQUESTED, PROJECT_CREATED],
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
      ["append", PROJECT_CREATE_REQUESTED, PROJECT_CREATED],
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
      ["append", PROJECT_CREATE_REQUESTED, PROJECT_CREATED],
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
      ["append", PROJECT_CREATE_REQUESTED, PROJECT_CREATED],
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
      ["append", PROJECT_CREATE_REQUESTED, PROJECT_CREATED],
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
      ["append", PROJECT_CREATE_REQUESTED, PROJECT_CREATED],
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
      ["append", PROJECT_CREATE_REQUESTED, PROJECT_CREATED],
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
      ["append", PROJECT_CREATE_REQUESTED, PROJECT_CREATED],
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
      ["append", PROJECT_CREATE_REQUESTED, PROJECT_CREATED],
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
      ["append", PROJECT_CREATE_REQUESTED, PROJECT_CREATED],
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
      ["append", PROJECT_CREATE_REQUESTED, PROJECT_CREATED],
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
    // whole birth saga, the terminal certificate, the custom-domain observations)
    // re-runs. Each must produce a body IDENTICAL to the committed one so the
    // idempotency keys dedupe — a same-key-different-body append would be
    // REJECTED and wedge the frame.
    const h = makeProjectHarness();
    await h.stream.append(
      ...projectCreationEvents({
        projectId: "prj_test",
        payload: PROJECT_CREATE_REQUESTED.payload,
      }),
    );
    await h.settle();
    await h.play(
      ["append", CONFIG_REPO_CREATED],
      [
        "append",
        {
          type: "events.iterate.com/project/custom-domain-add-requested",
          payload: { hostname: "garple.com" },
        },
      ],
    );
    const committedOffsets = h.events().map((row) => row.offset);
    expect(h.state()).toMatchObject({
      birthCertificate: PROJECT_CREATED.payload,
      notificationReady: true,
    });

    const replay = makeProjectHarness({
      substrate: { clock: h.clock, stream: h.stream, progress: makeMemoryProgressStore() },
    });
    await replay.settle(); // replays the whole stream; a wedge would throw here

    expect(replay.events().map((row) => row.offset)).toEqual(committedOffsets);
    expect(replay.state()).toMatchObject({
      birthCertificate: PROJECT_CREATED.payload,
      notificationReady: true,
      customDomains: [{ hostname: "garple.com", status: "pending_validation" }],
    });
  });
});
