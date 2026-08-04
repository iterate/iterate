import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";

const mocks = vi.hoisted(() => ({
  appendIfStreamId: vi.fn<
    (input: { events: Array<Record<string, unknown>>; streamId: string }) => Promise<unknown[]>
  >(async () => []),
  createArtifact: vi.fn(),
  getEvent: vi.fn(),
  getEventPage: vi.fn(),
  resolveSource: vi.fn(),
}));

vi.mock("../../auth.ts", () => ({ trustedInternalAuthContext: () => ({}) }));
vi.mock("../../env.ts", () => ({ workerVersion: () => "test-version" }));
vi.mock("../../rpc-targets.ts", () => ({
  StreamRpcTarget: class {
    appendIfStreamId = mocks.appendIfStreamId;
    getEvent = mocks.getEvent;
    getEventPage = mocks.getEventPage;
  },
}));
vi.mock("./github-template-creation.ts", () => ({
  createGithubTemplateArtifact: mocks.createArtifact,
}));
vi.mock("./github-template-source.ts", () => ({
  createGithubTemplateSource: () => ({ resolve: mocks.resolveSource }),
  isRetryableGithubTemplateSourceError: (error: unknown) =>
    (error as { retryable?: boolean } | null)?.retryable === true,
}));

const { RepoCreationCoordinatorDurableObject } =
  await import("./repo-creation-coordinator-durable-object.ts");

const repoName = DurableObjectNameCodec.stringify({
  path: "/repos/config",
  projectId: "prj_test",
});
const request = {
  type: "github-public-template" as const,
  owner: "iterate",
  path: "configs/with-voice",
  ref: "main",
  repo: "iterate",
};
const handoff = { request, streamId: "stream-1" };
const queuedHandoff = { ...handoff, failedAttempts: 0 };
const resolvedSource = {
  branch: "default-configs",
  commitSha: "a".repeat(40),
  owner: request.owner,
  path: request.path,
  ref: request.ref,
  repo: request.repo,
};
const artifact = {
  artifactName: "prj_test--L3JlcG9zL2NvbmZpZw",
  defaultBranch: "main",
  remote: "https://account.artifacts.cloudflare.net/git/ns/prj_test.git",
};

function committedRequest() {
  return {
    createdAt: new Date(0).toISOString(),
    offset: 1,
    path: "/repos/config",
    payload: request,
    type: "events.iterate.com/repos/create-requested",
  };
}

function coordinator(records = new Map<string, unknown>()) {
  let alarmAt: number | null = null;
  const setAlarm = vi.fn<(scheduledTime: number | Date) => Promise<void>>(async (scheduledTime) => {
    alarmAt = Number(scheduledTime);
  });
  const ctx = {
    id: { name: repoName },
    storage: {
      getAlarm: vi.fn(async () => alarmAt),
      kv: {
        delete: (key: string) => records.delete(key),
        get: <T>(key: string) => records.get(key) as T | undefined,
        put: (key: string, value: unknown) => records.set(key, value),
      },
      setAlarm,
    },
  } as unknown as DurableObjectState;
  const env = {
    ARTIFACTS: {},
    ARTIFACTS_ACCOUNT_ID: "account",
    ARTIFACTS_NAMESPACE: "ns",
  } as unknown as Env;
  return {
    clearAlarm: () => {
      alarmAt = null;
    },
    records,
    setAlarm,
    value: new RepoCreationCoordinatorDurableObject(ctx, env),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEventPage.mockResolvedValue({
    events: [committedRequest()],
    streamId: handoff.streamId,
    streamMaxOffset: 1,
  });
  mocks.getEvent.mockResolvedValue(undefined);
  mocks.resolveSource.mockResolvedValue(resolvedSource);
  mocks.createArtifact.mockResolvedValue(artifact);
});

describe("RepoCreationCoordinatorDurableObject", () => {
  it("persists the exact fenced handoff without doing vendor work in the caller RPC", async () => {
    const h = coordinator();

    await h.value.enqueue(handoff);

    expect([...h.records.values()]).toEqual([queuedHandoff]);
    expect(h.setAlarm).toHaveBeenCalledOnce();
    expect(mocks.resolveSource).not.toHaveBeenCalled();
    expect(mocks.createArtifact).not.toHaveBeenCalled();
  });

  it("preserves a queued retry deadline and rejects a conflicting handoff", async () => {
    const h = coordinator();
    await h.value.enqueue(handoff);
    await h.value.enqueue(handoff);

    expect(h.setAlarm).toHaveBeenCalledOnce();
    await expect(h.value.enqueue({ ...handoff, streamId: "different-stream" })).rejects.toThrow(
      "different template-creation handoff",
    );
  });

  it("re-arms a queued handoff whose alarm was lost during a reset", async () => {
    const h = coordinator();
    await h.value.enqueue(handoff);
    h.clearAlarm();

    await h.value.enqueue(handoff);

    expect(h.setAlarm).toHaveBeenCalledTimes(2);
    expect([...h.records.values()]).toEqual([queuedHandoff]);
  });

  it("upgrades the original boolean queue record when the processor next confirms the request", async () => {
    const h = coordinator(new Map([["repo-creation:queued", true]]));

    await h.value.enqueue(handoff);

    expect([...h.records.values()]).toEqual([queuedHandoff]);
    expect(h.setAlarm).toHaveBeenCalledOnce();
  });

  it("recovers an original boolean queue directly from its journaled request", async () => {
    const h = coordinator(new Map([["repo-creation:queued", true]]));

    await h.value.alarm();

    expect(mocks.resolveSource).toHaveBeenCalledWith(request);
    expect(mocks.createArtifact).toHaveBeenCalledOnce();
    expect(mocks.appendIfStreamId).toHaveBeenCalledTimes(2);
    expect(h.records.size).toBe(0);
  });

  it("resolves, journals, materializes, and settles without calling the Repo actor", async () => {
    const h = coordinator();
    await h.value.enqueue(handoff);

    await h.value.alarm();

    expect(mocks.resolveSource).toHaveBeenCalledWith(request);
    expect(mocks.createArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactName: "prj_test--L3JlcG9zL2NvbmZpZw",
        projectId: "prj_test",
        repoPath: "/repos/config",
        source: resolvedSource,
      }),
    );
    expect(mocks.appendIfStreamId).toHaveBeenCalledTimes(2);
    expect(mocks.appendIfStreamId.mock.calls.map(([input]) => input.events[0])).toMatchObject([
      {
        idempotencyKey:
          'iterate-internal/repo-template-source-resolved:["prj_test","/repos/config"]',
        payload: resolvedSource,
        type: "events.iterate.com/repos/template-source-resolved",
      },
      {
        idempotencyKey: "repo/created",
        payload: { ...artifact, request },
        type: "events.iterate.com/repos/created",
      },
    ]);
    expect(h.records.size).toBe(0);
  });

  it("reuses the journaled immutable source after an interrupted materialization", async () => {
    mocks.getEvent.mockResolvedValue({
      createdAt: new Date(0).toISOString(),
      idempotencyKey: 'iterate-internal/repo-template-source-resolved:["prj_test","/repos/config"]',
      offset: 2,
      path: "/repos/config",
      payload: resolvedSource,
      type: "events.iterate.com/repos/template-source-resolved",
    });
    const h = coordinator();
    await h.value.enqueue(handoff);

    await h.value.alarm();

    expect(mocks.resolveSource).not.toHaveBeenCalled();
    expect(mocks.createArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ source: resolvedSource }),
    );
    expect(mocks.appendIfStreamId).toHaveBeenCalledOnce();
  });

  it("keeps a classified source outage open on a bounded explicit retry", async () => {
    const failure = Object.assign(new Error("GitHub unavailable"), { retryable: true });
    mocks.resolveSource.mockRejectedValue(failure);
    const h = coordinator();
    await h.value.enqueue(handoff);

    await expect(h.value.alarm()).resolves.toBeUndefined();

    expect([...h.records.values()]).toEqual([{ ...queuedHandoff, failedAttempts: 1 }]);
    expect(h.setAlarm).toHaveBeenCalledTimes(2);
    expect(mocks.appendIfStreamId).not.toHaveBeenCalled();
  });

  it("settles a classified outage with a durable explanation after five attempts", async () => {
    const failure = Object.assign(new Error("GitHub unavailable"), { retryable: true });
    mocks.resolveSource.mockRejectedValue(failure);
    const h = coordinator();
    await h.value.enqueue(handoff);

    for (let attempt = 0; attempt < 5; attempt += 1) await h.value.alarm();

    expect(h.setAlarm).toHaveBeenCalledTimes(5);
    expect(mocks.appendIfStreamId).toHaveBeenCalledOnce();
    expect(mocks.appendIfStreamId.mock.calls[0]?.[0].events[0]).toMatchObject({
      idempotencyKey: "repo/create-failed",
      payload: {
        error: "Public template creation failed after 5 attempts: GitHub unavailable",
        request,
      },
      type: "events.iterate.com/repos/create-failed",
    });
    expect(h.records.size).toBe(0);
  });

  it("does not turn an invariant violation into an explicit retry loop", async () => {
    mocks.getEventPage.mockResolvedValue({
      events: [],
      streamId: handoff.streamId,
      streamMaxOffset: 0,
    });
    const h = coordinator();
    await h.value.enqueue(handoff);

    await expect(h.value.alarm()).rejects.toThrow("no durable create-requested fact");

    expect([...h.records.values()]).toEqual([queuedHandoff]);
    expect(h.setAlarm).toHaveBeenCalledOnce();
    expect(mocks.resolveSource).not.toHaveBeenCalled();
    expect(mocks.createArtifact).not.toHaveBeenCalled();
  });

  it("journals a terminal failure for invalid template input", async () => {
    mocks.resolveSource.mockRejectedValue(new Error("Template path does not exist"));
    const h = coordinator();
    await h.value.enqueue(handoff);

    await h.value.alarm();

    expect(mocks.appendIfStreamId).toHaveBeenCalledOnce();
    expect(mocks.appendIfStreamId.mock.calls[0]?.[0].events[0]).toMatchObject({
      idempotencyKey: "repo/create-failed",
      payload: { error: "Template path does not exist", request },
      type: "events.iterate.com/repos/create-failed",
    });
    expect(h.records.size).toBe(0);
  });

  it("drops an obsolete handoff before vendor work when the stream lifetime changed", async () => {
    mocks.getEventPage.mockResolvedValue({
      events: [committedRequest()],
      streamId: "replacement-stream",
      streamMaxOffset: 1,
    });
    const h = coordinator();
    await h.value.enqueue(handoff);

    await h.value.alarm();

    expect(mocks.resolveSource).not.toHaveBeenCalled();
    expect(mocks.createArtifact).not.toHaveBeenCalled();
    expect(h.records.size).toBe(0);
  });
});
