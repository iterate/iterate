// Repo creation and GitHub import recovery through the production-shaped
// processor registry. `crash()` replaces the incarnation while preserving the
// stream, processor progress, and durable alarm.

import { describe, expect, it, vi } from "vitest";
import { KEEPALIVE_ALARM_LEAD_MS } from "iterate/processors";
import { MemoryStreamNetwork } from "iterate/processors/testing";
import {
  createStreamProcessorRegistry,
  type StreamProcessorRegistry,
} from "iterate/processors/cloudflare";
import { RepoProcessorContract, type RepoCreateRequest } from "./repo-processor-contract.ts";
import { RepoProcessor } from "./repo-processor-implementation.ts";
import { RepoNotSeededError } from "./utils.ts";

const HOME = "/repos/config";
const PROJECT_ID = "prj_1";
const SLUG = RepoProcessorContract.slug;
const GITHUB_LINK = {
  connection: "install-789",
  installationId: "789",
  owner: "acme",
  repo: "widgets",
  repositoryId: 101,
};
const CREATED_ARTIFACT = {
  artifactName: "prj_1--L3JlcG9zL2NvbmZpZw",
  defaultBranch: "main",
  remote: "https://example.artifacts.cloudflare.net/git/ns/prj_1--L3JlcG9zL2NvbmZpZw.git",
};
const EMPTY_REQUEST = {
  type: "events.iterate.com/repos/create-requested" as const,
  payload: { type: "empty" as const },
};

function created(request: RepoCreateRequest) {
  return {
    type: "events.iterate.com/repos/created" as const,
    payload: { ...CREATED_ARTIFACT, request },
  };
}

function makeHarness() {
  const clock = { now: Date.parse("2026-07-14T12:00:00Z") };
  const network = new MemoryStreamNetwork(() => clock.now);
  const stream = network.get(HOME);
  const kv = new Map<string, unknown>();
  const alarm: { at: number | null } = { at: null };
  let pending: Promise<unknown>[] = [];
  const ctx = {
    storage: {
      kv: {
        get: (key: string) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
        put: (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
        delete: (key: string) => kv.delete(key),
      },
      getAlarm: async () => alarm.at,
      setAlarm: async (at: number | Date) => {
        alarm.at = typeof at === "number" ? at : at.getTime();
      },
      deleteAlarm: async () => {
        alarm.at = null;
      },
    },
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise.catch(() => undefined)),
  } as unknown as DurableObjectState;

  const effects = {
    createEmpty: async (): Promise<typeof CREATED_ARTIFACT> => {
      throw new Error("must not create empty artifact in this scenario");
    },
    importPublic: async (_input: {
      depth?: number;
      owner: string;
      repo: string;
    }): Promise<typeof CREATED_ARTIFACT> => {
      throw new Error("must not import public artifact in this scenario");
    },
    link: async (_input: { connection: string; owner: string; repo: string }): Promise<void> => {
      throw new Error("must not link GitHub in this scenario");
    },
    syncPrivate: async (): Promise<void> => {
      throw new Error("must not sync private GitHub in this scenario");
    },
    syncPush: async (_input: {
      afterCommitOid: string;
      branch: string;
    }): Promise<{ commitOid: string }> => {
      throw new Error("must not sync GitHub push in this scenario");
    },
  };

  let registry!: StreamProcessorRegistry;
  let processor!: RepoProcessor;
  const boot = () => {
    registry = createStreamProcessorRegistry(ctx, {
      stream,
      path: HOME,
      projectId: PROJECT_ID,
      version: "v-test",
      now: () => clock.now,
    });
    processor = registry.register(
      new RepoProcessor({
        stream,
        path: HOME,
        projectId: PROJECT_ID,
        createEmptyArtifact: () => effects.createEmpty(),
        importPublicGithubArtifact: (input) => effects.importPublic(input),
        linkGithub: (input) => effects.link(input),
        syncPrivateGithub: () => effects.syncPrivate(),
        syncFromGithubPush: (input) => effects.syncPush(input),
        observeArtifactPush: () => {},
        taskChangesForArtifactPush: async () => [],
      }),
      { recovery: true },
    );
  };
  boot();

  const settle = async () => {
    for (let round = 0; round < 5; round += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };
  const head = () => stream.events.at(-1)?.offset ?? 0;
  const harness = {
    alarm,
    clock,
    effects,
    head,
    kv,
    settle,
    stream,
    state: () => registry.reads(processor).currentState,
    crash() {
      pending = [];
      boot();
    },
    async wake() {
      return await registry.wakeStreamSubscriber({
        stream: { projectId: PROJECT_ID, path: HOME, streamMaxOffset: head() },
        subscriptionKey: "wake:repo",
        processorSlug: SLUG,
      });
    },
    async deliverPending() {
      const woken = await harness.wake();
      const events = stream.events.filter((event) => event.offset > woken.checkpointOffset);
      if (events.length > 0) {
        await woken.sink({
          projectId: PROJECT_ID,
          path: HOME,
          events,
          scannedAfterOffset: woken.checkpointOffset,
          scannedThroughOffset: head(),
          streamMaxOffset: head(),
          state: null,
        });
      }
      await settle();
      return woken;
    },
    async advance(ms: number) {
      const target = clock.now + ms;
      while (alarm.at !== null && alarm.at <= target) {
        clock.now = Math.max(clock.now, alarm.at);
        alarm.at = null;
        await registry.handleAlarm();
        await settle();
      }
      clock.now = target;
    },
  };
  return harness;
}

describe("RepoProcessor creation saga", () => {
  it("creates an empty Artifact and appends the terminal certificate", async () => {
    const h = makeHarness();
    let calls = 0;
    h.effects.createEmpty = async () => {
      calls += 1;
      return CREATED_ARTIFACT;
    };

    await h.stream.append(EMPTY_REQUEST);
    await h.deliverPending();

    expect(calls).toBe(1);
    expect(h.stream.events.at(-1)).toMatchObject({
      type: "events.iterate.com/repos/created",
      idempotencyKey: "repo/created",
      payload: { ...CREATED_ARTIFACT, request: EMPTY_REQUEST.payload },
    });
    await h.deliverPending();
    expect(h.state()).toMatchObject({ birthCertificate: { request: { type: "empty" } } });
    expect(calls).toBe(1);
  });

  it("imports a public GitHub repo through Artifacts, then links it", async () => {
    const h = makeHarness();
    const order: string[] = [];
    h.effects.importPublic = async (input) => {
      order.push(`import:${input.owner}/${input.repo}:depth-${input.depth ?? "full"}`);
      return CREATED_ARTIFACT;
    };
    h.effects.link = async (input) => void order.push(`link:${input.connection}`);
    await h.stream.append({
      type: "events.iterate.com/repos/create-requested",
      payload: {
        type: "github-public",
        connection: "install-789",
        depth: 1,
        owner: "acme",
        repo: "widgets",
      },
    });

    await h.deliverPending();

    expect(order).toEqual(["import:acme/widgets:depth-1", "link:install-789"]);
    expect(h.stream.events.at(-1)?.type).toBe("events.iterate.com/repos/created");
  });

  it("records a creation failure instead of claiming the repo is ready", async () => {
    const h = makeHarness();
    let calls = 0;
    h.effects.importPublic = async () => {
      calls += 1;
      throw new Error("Cloudflare Artifacts 10400: An internal error occurred");
    };
    const request = {
      type: "github-public" as const,
      connection: "install-789",
      owner: "acme",
      repo: "widgets",
    };
    await h.stream.append({
      type: "events.iterate.com/repos/create-requested",
      payload: request,
    });

    await h.deliverPending();
    await vi.waitFor(() => {
      expect(h.stream.events.at(-1)).toMatchObject({
        type: "events.iterate.com/repos/create-failed",
        idempotencyKey: "repo/create-failed",
        payload: {
          error: "Cloudflare Artifacts 10400: An internal error occurred",
          request,
        },
      });
    });
    await h.deliverPending();

    expect(calls).toBe(1);
    expect(h.state()).toMatchObject({
      createFailure: {
        error: "Cloudflare Artifacts 10400: An internal error occurred",
        request,
      },
    });
    expect(
      h.stream.events.filter((event) => event.type === "events.iterate.com/repos/created"),
    ).toHaveLength(0);
  });

  it("seeds an Artifact, links a private GitHub repo, then performs its depth-one sync", async () => {
    const h = makeHarness();
    const order: string[] = [];
    h.effects.createEmpty = async () => {
      order.push("seed");
      return CREATED_ARTIFACT;
    };
    h.effects.link = async () => void order.push("link");
    h.effects.syncPrivate = async () => void order.push("sync-depth-one");
    await h.stream.append({
      type: "events.iterate.com/repos/create-requested",
      payload: {
        type: "github-private",
        connection: "install-789",
        owner: "acme",
        repo: "widgets",
      },
    });

    await h.deliverPending();

    expect(order).toEqual(["seed", "link", "sync-depth-one"]);
    expect(h.stream.events.at(-1)?.type).toBe("events.iterate.com/repos/created");
  });

  it("does not perform creation while the processor is behind the stream head", async () => {
    const h = makeHarness();
    let calls = 0;
    h.effects.createEmpty = async () => {
      calls += 1;
      return CREATED_ARTIFACT;
    };
    const [request] = await h.stream.append(EMPTY_REQUEST);
    const woken = await h.wake();
    await woken.sink({
      projectId: PROJECT_ID,
      path: HOME,
      events: [request!],
      scannedAfterOffset: woken.checkpointOffset,
      scannedThroughOffset: request!.offset,
      streamMaxOffset: request!.offset + 1,
      state: null,
    });
    await h.settle();
    expect(calls).toBe(0);

    await h.stream.append({
      type: "events.iterate.com/repo/github-link-configured",
      payload: GITHUB_LINK,
    });
    await h.deliverPending();
    expect(calls).toBe(1);
  });

  it("does not repeat completed creation when rebuilding state from the stream", async () => {
    const h = makeHarness();
    let calls = 0;
    h.effects.createEmpty = async () => {
      calls += 1;
      return CREATED_ARTIFACT;
    };
    await h.stream.append(EMPTY_REQUEST);
    await h.deliverPending();
    await h.deliverPending();
    const streamLength = h.stream.events.length;
    const state = h.state();
    expect(calls).toBe(1);

    h.kv.clear();
    h.crash();
    h.effects.createEmpty = async () => {
      throw new Error("completed creation must not run during a replay");
    };
    await h.deliverPending();

    expect(h.stream.events).toHaveLength(streamLength);
    expect(h.state()).toEqual(state);
  });
});

describe("RepoProcessor eviction recovery", () => {
  it("redelivers empty creation interrupted by a deployment without poisoning the repo", async () => {
    const h = makeHarness();
    let calls = 0;
    h.effects.createEmpty = async () => {
      calls += 1;
      if (calls === 1) {
        const reset = Object.assign(
          new Error("Durable Object reset because its code was updated."),
          { durableObjectReset: true },
        );
        throw new Error("Artifact client could not create the repo", { cause: reset });
      }
      return CREATED_ARTIFACT;
    };
    await h.stream.append(EMPTY_REQUEST);

    await expect(h.deliverPending()).rejects.toThrow("Artifact client could not create the repo");
    expect(
      h.stream.events.some((event) => event.type === "events.iterate.com/repos/create-failed"),
    ).toBe(false);

    await h.deliverPending();

    expect(calls).toBe(2);
    expect(
      h.stream.events.filter((event) => event.type === "events.iterate.com/repos/created"),
    ).toHaveLength(1);
  });

  it("redelivers a still-materializing empty Artifact without recording failure", async () => {
    const h = makeHarness();
    let calls = 0;
    h.effects.createEmpty = async () => {
      calls += 1;
      if (calls === 1) throw new RepoNotSeededError("Artifact import is still in progress");
      return CREATED_ARTIFACT;
    };
    await h.stream.append(EMPTY_REQUEST);
    await expect(h.deliverPending()).rejects.toThrow("Artifact import is still in progress");

    expect(
      h.stream.events.some((event) => event.type === "events.iterate.com/repos/create-failed"),
    ).toBe(false);

    await h.deliverPending();

    expect(calls).toBe(2);
    expect(
      h.stream.events.filter((event) => event.type === "events.iterate.com/repos/created"),
    ).toHaveLength(1);
  });

  it("re-drives an interrupted creation obligation after revival", async () => {
    const h = makeHarness();
    h.effects.createEmpty = () => new Promise<never>(() => {});
    await h.stream.append(EMPTY_REQUEST);
    const woken = await h.wake();
    void Promise.resolve(
      woken.sink({
        projectId: PROJECT_ID,
        path: HOME,
        events: h.stream.events,
        scannedAfterOffset: woken.checkpointOffset,
        scannedThroughOffset: h.head(),
        streamMaxOffset: h.head(),
        state: null,
      }),
    ).catch(() => undefined);
    await h.settle();
    expect(h.alarm.at).not.toBeNull();

    h.crash();
    h.effects.createEmpty = async () => CREATED_ARTIFACT;
    await h.advance(KEEPALIVE_ALARM_LEAD_MS + 1);
    expect(
      h.stream.events.filter(
        (event) => event.type === "events.iterate.com/stream/processor-revived",
      ),
    ).toHaveLength(1);

    await h.deliverPending();
    expect(
      h.stream.events.filter((event) => event.type === "events.iterate.com/repos/created"),
    ).toHaveLength(1);
  });

  it("re-drives an interrupted GitHub push import after revival", async () => {
    const h = makeHarness();
    await h.stream.append(EMPTY_REQUEST, created(EMPTY_REQUEST.payload));
    await h.deliverPending();
    h.effects.syncPush = () => new Promise<never>(() => {});
    await h.stream.append({
      type: "events.iterate.com/repo/github-import-requested",
      payload: { branch: "main", requestId: `${HOME}:42`, requestedCommitOid: "requested-head" },
    });
    await h.deliverPending();
    await vi.waitFor(() => {
      expect(
        h.stream.events.some(
          (event) => event.type === "events.iterate.com/repo/github-import-started",
        ),
      ).toBe(true);
    });
    await h.deliverPending();
    expect((await h.wake()).checkpointOffset).toBe(h.head());

    h.crash();
    const calls: unknown[] = [];
    h.effects.syncPush = async (input) => {
      calls.push(input);
      return { commitOid: "current-github-head" };
    };
    await h.advance(KEEPALIVE_ALARM_LEAD_MS + 1);
    await h.deliverPending();
    await vi.waitFor(() => {
      expect(
        h.stream.events.find(
          (event) => event.type === "events.iterate.com/repo/github-import-completed",
        )?.payload,
      ).toMatchObject({ commitOid: "current-github-head", requestId: `${HOME}:42` });
    });
    expect(calls).toEqual([{ afterCommitOid: "requested-head", branch: "main" }]);
  });
});
