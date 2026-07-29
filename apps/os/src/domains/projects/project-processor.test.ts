import { describe, expect, it } from "vitest";
import { makeMemoryProgressStore } from "iterate/processors/testing";
import { WorkerBuildFailedError } from "../workers/artifact-store.ts";
import { workerBuildingResponse } from "../workers/worker-fetch-dispatch.ts";
import { internalStreamId } from "../streams/stream-delivery-utils.ts";
import { projectCreationEvents } from "./project-defaults.ts";
import {
  CONFIG_REPO_COMMIT_COMPLETED,
  CONFIG_REPO_CREATED,
  CONFIG_REPO_CREATE_FAILED,
  PROJECT,
  PROJECT_CREATED,
  PROJECT_CREATE_REQUESTED,
  makeProjectHarness,
  type ProjectEventInput,
} from "./project-processor-test-harness.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";

// =============================================================================
// Project worker lifecycle
// =============================================================================

describe("ProjectProcessor worker lifecycle", () => {
  it("publishes the seed worker update from the creation terminal without reacting to its raw commit", async () => {
    const h = makeProjectHarness();
    await h.play([
      "append",
      PROJECT_CREATE_REQUESTED,
      CONFIG_REPO_COMMIT_COMPLETED,
      CONFIG_REPO_CREATED,
    ]);

    // Only the repos/created terminal probes the seed worker. Translating the
    // earlier seed commit would add a second probe and could hold the project
    // processor cursor ahead of the event that terminalizes creation. The
    // successful creation probe supplies the first clean lifecycle fact.
    expect(h.workerFetchCalls()).toBe(1);
    expect(h.events("events.iterate.com/project/worker-updated")).toMatchObject([
      {
        idempotencyKey: `project/worker-update:${"b".repeat(40)}`,
        payload: { commitOid: "b".repeat(40) },
      },
    ]);
    expect(h.events("events.iterate.com/project/created")).toHaveLength(1);
  });

  it("publishes project/worker-updated only after the changed config worker answers", async () => {
    const h = makeProjectHarness({
      workerOutcomes: [
        workerBuildingResponse(),
        Response.json({ app: "hello", projectId: "prj_test" }),
      ],
    });
    await h.play([
      "append",
      PROJECT_CREATE_REQUESTED,
      PROJECT_CREATED,
      CONFIG_REPO_COMMIT_COMPLETED,
    ]);

    expect(h.workerFetchCalls()).toBe(2);
    expect(h.events("events.iterate.com/project/worker-updated")).toMatchObject([
      {
        idempotencyKey: `project/worker-update:${"b".repeat(40)}`,
        payload: { commitOid: "b".repeat(40) },
      },
    ]);
  });

  it("publishes the worker identity actually served when HEAD advances past the triggering commit", async () => {
    const servedCommitOid = "c".repeat(40);
    const h = makeProjectHarness({ workerCommitOids: [servedCommitOid] });
    await h.play([
      "append",
      PROJECT_CREATE_REQUESTED,
      PROJECT_CREATED,
      CONFIG_REPO_COMMIT_COMPLETED,
    ]);

    expect(h.events("events.iterate.com/project/worker-updated")).toMatchObject([
      {
        idempotencyKey: `project/worker-update:${CONFIG_REPO_COMMIT_COMPLETED.payload.commitOid}`,
        payload: { commitOid: servedCommitOid },
      },
    ]);
  });

  it("does not reprobe a coalesced config trigger after losing its checkpoint", async () => {
    const servedCommitOid = "c".repeat(40);
    const h = makeProjectHarness({ workerCommitOids: [servedCommitOid] });
    await h.play([
      "append",
      PROJECT_CREATE_REQUESTED,
      PROJECT_CREATED,
      CONFIG_REPO_COMMIT_COMPLETED,
    ]);
    expect(h.workerFetchCalls()).toBe(1);

    const replay = makeProjectHarness({
      substrate: {
        clock: h.clock,
        stream: h.stream,
        progress: makeMemoryProgressStore(ProjectProcessorContract),
      },
      workerOutcomes: [
        new WorkerBuildFailedError({ kind: "source", message: "new HEAD is broken" }),
      ],
    });
    await replay.settle();

    expect(replay.workerFetchCalls()).toBe(0);
    expect(replay.events("events.iterate.com/project/worker-updated")).toMatchObject([
      {
        idempotencyKey: `project/worker-update:${CONFIG_REPO_COMMIT_COMPLETED.payload.commitOid}`,
        payload: { commitOid: servedCommitOid },
      },
    ]);
    expect(replay.events("events.iterate.com/project/worker-update-failed")).toEqual([]);
  });

  it("does not probe again when a committed worker update is redelivered", async () => {
    const h = makeProjectHarness();
    await h.play([
      "append",
      PROJECT_CREATE_REQUESTED,
      PROJECT_CREATED,
      CONFIG_REPO_COMMIT_COMPLETED,
    ]);
    expect(h.workerFetchCalls()).toBe(1);

    const replay = makeProjectHarness({
      substrate: {
        clock: h.clock,
        stream: h.stream,
        progress: makeMemoryProgressStore(ProjectProcessorContract),
      },
    });
    await replay.settle();

    expect(replay.workerFetchCalls()).toBe(0);
    expect(replay.events("events.iterate.com/project/worker-updated")).toHaveLength(1);
  });

  it("does not translate a commit from another repo", async () => {
    const h = makeProjectHarness();
    await h.play([
      "append",
      PROJECT_CREATE_REQUESTED,
      PROJECT_CREATED,
      {
        ...CONFIG_REPO_COMMIT_COMPLETED,
        source: {
          copiedFrom: [
            {
              ...CONFIG_REPO_COMMIT_COMPLETED.source.copiedFrom[0],
              path: "/repos/application",
            },
          ],
        },
      },
    ]);

    expect(h.workerFetchCalls()).toBe(0);
    expect(h.events("events.iterate.com/project/worker-updated")).toEqual([]);
  });

  it("records a deterministic update failure without blocking a later fixed commit", async () => {
    const fixedCommit = {
      ...CONFIG_REPO_COMMIT_COMPLETED,
      payload: {
        ...CONFIG_REPO_COMMIT_COMPLETED.payload,
        beforeCommitOid: CONFIG_REPO_COMMIT_COMPLETED.payload.commitOid,
        commitOid: "c".repeat(40),
      },
      source: {
        copiedFrom: [
          {
            ...CONFIG_REPO_COMMIT_COMPLETED.source.copiedFrom[0],
            offset: 6,
          },
        ],
      },
    } satisfies ProjectEventInput;
    const h = makeProjectHarness({
      workerOutcomes: [
        new WorkerBuildFailedError({ kind: "source", message: "Expected ; but found is" }),
        Response.json({ app: "fixed" }),
      ],
      workerCommitOids: ["b".repeat(40), "c".repeat(40)],
    });
    await h.play(
      ["append", PROJECT_CREATE_REQUESTED, PROJECT_CREATED, CONFIG_REPO_COMMIT_COMPLETED],
      ["append", fixedCommit],
    );

    expect(h.events("events.iterate.com/project/worker-update-failed")).toMatchObject([
      {
        idempotencyKey: `project/worker-update:${"b".repeat(40)}`,
        payload: {
          commitOid: "b".repeat(40),
          error: "Expected ; but found is",
        },
      },
    ]);
    expect(h.events("events.iterate.com/project/worker-updated")).toMatchObject([
      {
        idempotencyKey: `project/worker-update:${"c".repeat(40)}`,
        payload: { commitOid: "c".repeat(40) },
      },
    ]);
  });

  it("leaves a transient update probe failure open for durable redelivery", async () => {
    const h = makeProjectHarness({
      workerOutcomes: [new Error("temporary worker dispatch outage")],
    });
    await h.stream.append(PROJECT_CREATE_REQUESTED, PROJECT_CREATED, CONFIG_REPO_COMMIT_COMPLETED);

    await expect(h.settle()).rejects.toThrow("temporary worker dispatch outage");
    expect(h.events("events.iterate.com/project/worker-updated")).toEqual([]);
    expect(h.events("events.iterate.com/project/worker-update-failed")).toEqual([]);

    await h.settle();
    expect(h.events("events.iterate.com/project/worker-updated")).toHaveLength(1);
  });
});

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

  it("waits through a cold build before installing the userspace feed and appending project/created", async () => {
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
        idempotencyKey: "project-worker-subscription:prj_test",
        payload: {
          receiver: {
            action: "itx-call",
            expression: ["processEventBatch"],
            delivery: {
              start: "now",
              onFailingEvent: "skip",
            },
          },
        },
      },
    ]);
    expect(h.state().birthCertificate).toEqual(PROJECT_CREATED.payload);
  });

  it("terminalizes a deterministic worker source-build failure", async () => {
    const h = makeProjectHarness({
      workerOutcomes: [
        new WorkerBuildFailedError({ kind: "source", message: "Expected ; but found is" }),
      ],
      workerRetrySleep: async () => undefined,
    });
    await h.stream.append(PROJECT_CREATE_REQUESTED, CONFIG_REPO_CREATED);

    await h.settle();
    expect(h.workerFetchCalls()).toBe(1);
    expect(h.events("events.iterate.com/project/created")).toEqual([]);
    expect(h.events("events.iterate.com/stream/subscription-removed")).toEqual([]);
    expect(h.events("events.iterate.com/project/create-failed")).toMatchObject([
      {
        idempotencyKey: internalStreamId("project-creation-terminal", "prj_test", "failed"),
        payload: {
          createRequestedAtOffset: 1,
          error: "Default project worker bootstrap failed: Expected ; but found is",
          request: PROJECT_CREATE_REQUESTED.payload,
        },
      },
    ]);
  });

  it("does not re-probe after a failed terminal committed but its checkpoint was lost", async () => {
    const h = makeProjectHarness({
      workerOutcomes: [
        new WorkerBuildFailedError({ kind: "source", message: "Expected ; but found is" }),
      ],
    });
    await h.stream.append(PROJECT_CREATE_REQUESTED, CONFIG_REPO_CREATED);
    await h.settle();

    // A fresh progress store replays from before the config-repo certificate,
    // while the failed terminal remains durable later in the same stream.
    // The default worker would now answer successfully if the reaction
    // incorrectly ran it again.
    const replay = makeProjectHarness({
      substrate: {
        clock: h.clock,
        stream: h.stream,
        progress: makeMemoryProgressStore(ProjectProcessorContract),
      },
    });
    await replay.settle();

    expect(replay.workerFetchCalls()).toBe(0);
    expect(replay.events("events.iterate.com/project/created")).toEqual([]);
    expect(replay.events("events.iterate.com/project/create-failed")).toHaveLength(1);
    expect(replay.state().createFailure).toMatchObject({
      error: "Default project worker bootstrap failed: Expected ; but found is",
    });
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
        idempotencyKey: internalStreamId("project-creation-terminal", "prj_test", "failed"),
        payload: {
          createRequestedAtOffset: 1,
          error: "Config repo creation failed: The backing repository could not be created.",
          request: PROJECT_CREATE_REQUESTED.payload,
        },
      },
    ]);
    expect(h.workerFetchCalls()).toBe(0);
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

  it("does not let a public processor-source claim settle project creation", async () => {
    const h = makeProjectHarness();
    await h.play(
      ["append", PROJECT_CREATE_REQUESTED],
      [
        "append",
        {
          ...PROJECT_CREATED,
          idempotencyKey: "project-created:prj_test",
          source: {
            processor: {
              slug: ProjectProcessorContract.slug,
              version: ProjectProcessorContract.version,
              stream: {
                path: "/",
                projectId: "prj_test",
                streamId: "00000000-0000-4000-8000-000000000001",
              },
              whileProcessing: { offset: 2, type: "events.iterate.com/repos/created" },
            },
          },
        },
      ],
    );

    expect(h.state().birthCertificate).toBeNull();
    expect(h.state().createFailure).toBeNull();
  });

  it("reduces only a terminal fact that exactly settles the open creation request", async () => {
    const failure = {
      type: "events.iterate.com/project/create-failed",
      idempotencyKey: internalStreamId("project-creation-terminal", "prj_test", "failed"),
      payload: {
        createRequestedAtOffset: 1,
        error: "not this request",
        request: PROJECT_CREATE_REQUESTED.payload,
      },
    } satisfies ProjectEventInput;
    const copiedSource = {
      copiedFrom: [
        {
          subscriptionKey: "project-config-to-root",
          streamId: "00000000-0000-4000-8000-000000000003",
          streamCreatedAt: new Date(1).toISOString(),
          cursorChangedAtSourceOffset: 1,
          createdAt: new Date(2).toISOString(),
          offset: 2,
          path: "/elsewhere",
          projectId: "prj_test",
          type: "events.iterate.com/project/created",
        },
      ],
    } satisfies NonNullable<ProjectEventInput["source"]>;

    for (const counterfeit of [
      { ...PROJECT_CREATED, idempotencyKey: "project-created:prj_test" },
      { ...PROJECT_CREATED, source: copiedSource },
      { ...failure, idempotencyKey: "project/create-failed" },
      { ...failure, source: copiedSource },
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
        payload: { ...failure.payload, createRequestedAtOffset: 999 },
      },
      {
        ...failure,
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
  it("catalogs physical paths and received domain objects without reducing agent collection facts", async () => {
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

  it("uses the creation-request slug before terminal creation when the directory has no entry", async () => {
    const h = makeProjectHarness();
    h.customDomains.readProject.mockResolvedValueOnce(null);
    await h.play(
      ["append", PROJECT_CREATE_REQUESTED],
      [
        "append",
        {
          type: "events.iterate.com/project/custom-domain-add-requested",
          payload: { hostname: "garple.com" },
        },
      ],
    );

    expect(h.state().birthCertificate).toBeNull();
    expect(h.customDomains.ensure).toHaveBeenCalledWith({
      hostname: "garple.com",
      project: { id: "prj_test", slug: "demo", organizationId: null, name: "demo" },
    });
  });

  it("records provisioning failure without inventing configured state", async () => {
    const h = makeProjectHarness();
    h.customDomains.ensure.mockRejectedValueOnce(new Error("Cloudflare is unavailable"));
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

    expect(h.events("events.iterate.com/project/custom-domain-provision-failed")).toMatchObject([
      { payload: { error: "Cloudflare is unavailable", hostname: "garple.com" } },
    ]);
    expect(h.state().customDomains).toEqual([]);
  });

  it("removes Cloudflare hostnames while direct hostnames remain operator-managed", async () => {
    const h = makeProjectHarness();
    await h.play(
      ["append", PROJECT_CREATE_REQUESTED, PROJECT_CREATED],
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
        debounceMs: 100,
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
    // whole birth saga, the terminal certificate, the custom-domain configuration)
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
      substrate: {
        clock: h.clock,
        stream: h.stream,
        progress: makeMemoryProgressStore(ProjectProcessorContract),
      },
    });
    await replay.settle(); // replays the whole stream; a wedge would throw here

    expect(replay.events().map((row) => row.offset)).toEqual(committedOffsets);
    expect(replay.state()).toMatchObject({
      birthCertificate: PROJECT_CREATED.payload,
      notificationReady: true,
      customDomains: [{ hostname: "garple.com", kind: "cloudflare" }],
    });
  });
});
