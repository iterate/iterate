import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../../env.ts";
import type { StreamEventInput } from "../streams/schemas.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { RepoArtifactNameCodec } from "../repos/utils.ts";
import {
  CLOUDFLARE_EVENT_RECEIVED_TYPE,
  GLOBAL_CLOUDFLARE_EVENTS_STREAM_PATH,
  REPO_CLOUDFLARE_ARTIFACT_EVENT_RECEIVED_TYPE,
  handleEventQueueBatch,
  isWorkerEventsQueue,
} from "./event-queue-entrypoint.ts";

type RecordedAppend = {
  events: StreamEventInput[];
  name: string;
};

function createEnv(options: { cloudflareApiToken?: string } = {}) {
  const appends: RecordedAppend[] = [];
  const env = {
    ARTIFACTS_ACCOUNT_ID: "account-1",
    ARTIFACTS_NAMESPACE: "os-prd-repos",
    ...(options.cloudflareApiToken === undefined
      ? {}
      : { APP_CONFIG_CLOUDFLARE__API_TOKEN: options.cloudflareApiToken }),
    STREAM: {
      getByName: vi.fn((name: string) => ({
        appendAck: vi.fn(async (...events: StreamEventInput[]) => {
          appends.push({ name, events });
        }),
      })),
    },
    WORKER_SELF: "os-prd",
  } as unknown as Pick<
    Env,
    "ARTIFACTS_ACCOUNT_ID" | "ARTIFACTS_NAMESPACE" | "STREAM" | "WORKER_SELF"
  > & { APP_CONFIG_CLOUDFLARE__API_TOKEN?: string };

  return { appends, env };
}

function createMessage(body: unknown, id = "msg-1") {
  return { id, body, ack: vi.fn(), retry: vi.fn(), timestamp: new Date(), attempts: 1 };
}

function createBatch(messages: ReturnType<typeof createMessage>[]) {
  return { queue: "os-prd-events", messages } as unknown as MessageBatch;
}

function eventsFor(appends: RecordedAppend[], name: string): StreamEventInput[] {
  return appends.filter((append) => append.name === name).flatMap((append) => append.events);
}

describe("event queue handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("recognizes the worker event queue", () => {
    const { env } = createEnv();

    expect(isWorkerEventsQueue("os-prd-events", env)).toBe(true);
    expect(isWorkerEventsQueue("os-prd-artifact-events", env)).toBe(false);
  });

  test("captures Cloudflare events globally and fans artifact events out to the repo stream", async () => {
    const { appends, env } = createEnv();
    const artifactName = RepoArtifactNameCodec.stringify({
      path: "/repos/project",
      projectId: "prj_123",
    });
    const cfEvent = {
      type: "cf.artifacts.repo.pushed",
      source: { type: "artifacts.repo", namespace: "os-prd-repos", repoName: artifactName },
      payload: { after: "bbb", before: "aaa", ref: "refs/heads/main" },
    };
    const message = createMessage(cfEvent, "msg-pushed");

    await handleEventQueueBatch(createBatch([message]), env);

    const globalName = DurableObjectNameCodec.stringify(
      { path: GLOBAL_CLOUDFLARE_EVENTS_STREAM_PATH, projectId: null },
      { allowNullProjectId: true },
    );
    const repoName = DurableObjectNameCodec.stringify({
      path: "/repos/project",
      projectId: "prj_123",
    });
    expect(eventsFor(appends, globalName)).toEqual([
      {
        type: CLOUDFLARE_EVENT_RECEIVED_TYPE,
        idempotencyKey: "cf-event:msg-pushed",
        payload: { body: cfEvent },
      },
    ]);
    expect(eventsFor(appends, repoName)).toEqual([
      {
        type: REPO_CLOUDFLARE_ARTIFACT_EVENT_RECEIVED_TYPE,
        idempotencyKey: "cf-artifact-event:msg-pushed",
        payload: {
          artifactName,
          body: cfEvent,
          cloudflareEventType: "cf.artifacts.repo.pushed",
          namespace: "os-prd-repos",
        },
      },
    ]);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  test("routes forked events to the target artifact repo when Cloudflare sends one", async () => {
    const { appends, env } = createEnv();
    const targetArtifactName = RepoArtifactNameCodec.stringify({
      path: "/",
      projectId: "prj_target",
    });
    const cfEvent = {
      type: "cf.artifacts.repo.forked",
      source: { type: "artifacts", namespace: "external-repos", repoName: "source-repo" },
      payload: { namespace: "os-prd-repos", repoName: targetArtifactName },
    };
    const message = createMessage(cfEvent, "msg-forked");

    await handleEventQueueBatch(createBatch([message]), env);

    const repoName = DurableObjectNameCodec.stringify({ path: "/", projectId: "prj_target" });
    expect(eventsFor(appends, repoName)).toEqual([
      expect.objectContaining({
        idempotencyKey: "cf-artifact-event:msg-forked",
        type: REPO_CLOUDFLARE_ARTIFACT_EVENT_RECEIVED_TYPE,
      }),
    ]);
    expect(message.ack).toHaveBeenCalledOnce();
  });

  test("subscribes addressable created repos to repo-level Artifact events", async () => {
    const { appends, env } = createEnv({ cloudflareApiToken: "cf-token" });
    const artifactName = RepoArtifactNameCodec.stringify({
      path: "/",
      projectId: "prj_123",
    });
    const cfEvent = {
      type: "cf.artifacts.repo.created",
      source: { type: "artifacts", namespace: "os-prd-repos", repoName: artifactName },
      payload: { repoId: "repo-1" },
    };
    const calls: Array<{ body?: unknown; method: string; path: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
        const path = new URL(String(url)).pathname + new URL(String(url)).search;
        calls.push({
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          method: init?.method ?? "GET",
          path,
        });
        if (path === "/client/v4/accounts/account-1/queues?page=1&per_page=100") {
          return Response.json({
            success: true,
            result: [{ queue_id: "queue-1", queue_name: "os-prd-events" }],
          });
        }
        if (
          path ===
          "/client/v4/accounts/account-1/event_subscriptions/subscriptions?page=1&per_page=100"
        ) {
          return Response.json({ success: true, result: [] });
        }
        if (
          path === "/client/v4/accounts/account-1/event_subscriptions/subscriptions" &&
          init?.method === "POST"
        ) {
          return Response.json({ success: true, result: { id: "subscription-1" } });
        }
        return Response.json({ success: false, errors: [{ message: path }] }, { status: 404 });
      }),
    );
    const message = createMessage(cfEvent, "msg-created");

    await handleEventQueueBatch(createBatch([message]), env);

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /client/v4/accounts/account-1/queues?page=1&per_page=100",
      "GET /client/v4/accounts/account-1/event_subscriptions/subscriptions?page=1&per_page=100",
      "POST /client/v4/accounts/account-1/event_subscriptions/subscriptions",
    ]);
    expect(calls[2]?.body).toMatchObject({
      destination: { queue_id: "queue-1", type: "queues.queue" },
      events: ["pushed", "cloned", "fetched"],
      name: expect.stringMatching(/^os-prd-artifact-repo-prj_123--Lw-[0-9a-f]{12}$/),
      source: {
        namespace: "os-prd-repos",
        repo_name: artifactName,
        type: "artifacts.repo",
      },
    });

    const repoName = DurableObjectNameCodec.stringify({ path: "/", projectId: "prj_123" });
    expect(eventsFor(appends, repoName)).toEqual([
      expect.objectContaining({
        idempotencyKey: "cf-artifact-event:msg-created",
        type: REPO_CLOUDFLARE_ARTIFACT_EVENT_RECEIVED_TYPE,
      }),
    ]);
    expect(message.ack).toHaveBeenCalledOnce();
  });

  test("still routes created repo events when repo subscription setup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { appends, env } = createEnv({ cloudflareApiToken: "cf-token" });
    const artifactName = RepoArtifactNameCodec.stringify({
      path: "/",
      projectId: "prj_123",
    });
    const cfEvent = {
      type: "cf.artifacts.repo.created",
      source: { type: "artifacts", namespace: "os-prd-repos", repoName: artifactName },
      payload: { repoId: "repo-1" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { success: false, errors: [{ message: "temporary outage" }] },
          { status: 503 },
        ),
      ),
    );
    const message = createMessage(cfEvent, "msg-created");

    await handleEventQueueBatch(createBatch([message]), env);

    const repoName = DurableObjectNameCodec.stringify({ path: "/", projectId: "prj_123" });
    expect(eventsFor(appends, repoName)).toEqual([
      expect.objectContaining({
        idempotencyKey: "cf-artifact-event:msg-created",
        type: REPO_CLOUDFLARE_ARTIFACT_EVENT_RECEIVED_TYPE,
      }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[event-queue] failed to ensure artifact repo subscription",
      expect.objectContaining({ repoName: artifactName }),
    );
    expect(message.ack).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  test("does not route incomplete forked events to the source repo", async () => {
    const { appends, env } = createEnv();
    const sourceArtifactName = RepoArtifactNameCodec.stringify({
      path: "/",
      projectId: "prj_source",
    });
    const cfEvent = {
      type: "cf.artifacts.repo.forked",
      source: { type: "artifacts", namespace: "os-prd-repos", repoName: sourceArtifactName },
      payload: { namespace: "os-prd-repos" },
    };
    const message = createMessage(cfEvent, "msg-incomplete-fork");

    await handleEventQueueBatch(createBatch([message]), env);

    const sourceRepoName = DurableObjectNameCodec.stringify({
      path: "/",
      projectId: "prj_source",
    });
    expect(eventsFor(appends, sourceRepoName)).toEqual([]);
    expect(appends).toHaveLength(1);
    expect(appends[0]!.events[0]).toEqual(
      expect.objectContaining({ idempotencyKey: "cf-event:msg-incomplete-fork" }),
    );
    expect(message.ack).toHaveBeenCalledOnce();
  });

  test("captures but does not fan out events from another artifact namespace", async () => {
    const { appends, env } = createEnv();
    const cfEvent = {
      type: "cf.artifacts.repo.pushed",
      source: { type: "artifacts.repo", namespace: "os-preview-1-repos", repoName: "x--Lw" },
    };
    const message = createMessage(cfEvent, "msg-other-namespace");

    await handleEventQueueBatch(createBatch([message]), env);

    expect(appends).toHaveLength(1);
    expect(appends[0]!.events[0]).toEqual(
      expect.objectContaining({ idempotencyKey: "cf-event:msg-other-namespace" }),
    );
    expect(message.ack).toHaveBeenCalledOnce();
  });

  test("captures malformed artifact names without retrying poison messages", async () => {
    const { appends, env } = createEnv();
    const cfEvent = {
      type: "cf.artifacts.repo.deleted",
      source: { type: "artifacts", namespace: "os-prd-repos", repoName: "not-decodable" },
    };
    const message = createMessage(cfEvent, "msg-bad-name");

    await handleEventQueueBatch(createBatch([message]), env);

    expect(appends).toHaveLength(1);
    expect(appends[0]!.events[0]).toEqual(
      expect.objectContaining({ idempotencyKey: "cf-event:msg-bad-name" }),
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  test("acknowledges unrecognized future queue messages without treating them as Cloudflare events", async () => {
    const { appends, env } = createEnv();
    const message = createMessage({ type: "internal.future", payload: { ok: true } }, "msg-future");

    await handleEventQueueBatch(createBatch([message]), env);

    expect(appends).toEqual([]);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  test("retries a message when stream append fails and keeps processing the rest", async () => {
    const { env } = createEnv();
    const first = createMessage(
      {
        type: "cf.artifacts.repo.created",
        source: { type: "artifacts", namespace: "os-prd-repos", repoName: "global--Lw" },
      },
      "msg-fail",
    );
    const second = createMessage(
      {
        type: "cf.artifacts.repo.deleted",
        source: { type: "artifacts", namespace: "os-prd-repos", repoName: "global--Lw" },
      },
      "msg-ok",
    );
    vi.mocked(env.STREAM.getByName).mockReturnValueOnce({
      appendAck: vi.fn(async () => {
        throw new Error("stream unavailable");
      }),
    } as never);

    await handleEventQueueBatch(createBatch([first, second]), env);

    expect(first.retry).toHaveBeenCalledOnce();
    expect(first.ack).not.toHaveBeenCalled();
    expect(second.ack).toHaveBeenCalledOnce();
    expect(second.retry).not.toHaveBeenCalled();
  });

  test("does not globally capture an addressable artifact event until repo fanout succeeds", async () => {
    const { appends, env } = createEnv();
    const artifactName = RepoArtifactNameCodec.stringify({
      path: "/repos/project",
      projectId: "prj_123",
    });
    const message = createMessage(
      {
        type: "cf.artifacts.repo.pushed",
        source: { type: "artifacts.repo", namespace: "os-prd-repos", repoName: artifactName },
      },
      "msg-repo-fails",
    );
    vi.mocked(env.STREAM.getByName).mockReturnValueOnce({
      appendAck: vi.fn(async () => {
        throw new Error("repo stream unavailable");
      }),
    } as never);

    await handleEventQueueBatch(createBatch([message]), env);

    expect(appends).toEqual([]);
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });
});
