import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  CF_EVENT_RECEIVED_TYPE,
  CF_EVENT_TYPES,
  REPO_ARTIFACT_CREATED_TYPE,
  REPO_CLONED_TYPE,
  REPO_FETCHED_TYPE,
  REPO_PUSHED_TYPE,
} from "./artifact-event-types.ts";
import { handleArtifactEventsBatch } from "./artifact-events-queue-handler.ts";
import type { ArtifactEventsQueueEnv } from "./artifact-events-queue-handler.ts";
import { getInitializedStreamStub } from "~/domains/streams/new-stream-runtime.ts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("~/domains/streams/new-stream-runtime.ts", () => ({
  getInitializedStreamStub: vi.fn(),
}));

const mockGetInitializedStreamStub = vi.mocked(getInitializedStreamStub);

function createMockStub() {
  return { append: vi.fn().mockResolvedValue({ offset: 1 }) };
}

function createMockMessage(body: unknown, id = "msg-1") {
  return {
    id,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
    timestamp: new Date(),
    attempts: 1,
  };
}

function createMockBatch(messages: ReturnType<typeof createMockMessage>[]) {
  return {
    queue: "test-queue",
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch;
}

const mockEnv = {
  ARTIFACTS_NAMESPACE: "os-prd-repos",
  STREAM: {} as ArtifactEventsQueueEnv["STREAM"],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleArtifactEventsBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("appends raw CF event to global cloudflare events stream", async () => {
    const stub = createMockStub();
    mockGetInitializedStreamStub.mockResolvedValue(stub as never);

    const cfEvent = {
      type: CF_EVENT_TYPES.REPO_CREATED,
      source: { type: "artifacts", repo_name: "proj-1--my-repo" },
      payload: { repoId: "abc", defaultBranch: "main" },
      metadata: { accountId: "acct-1", eventSubscriptionId: "sub-1" },
    };

    const message = createMockMessage(cfEvent, "msg-42");
    await handleArtifactEventsBatch(createMockBatch([message]), mockEnv);

    // First call = global cloudflare events stream
    const firstCallArgs = mockGetInitializedStreamStub.mock.calls[0]![0] as Record<string, unknown>;
    expect(firstCallArgs.namespace).toBe("os-prd-global");
    expect(firstCallArgs.path).toBe("/cloudflare/events");

    const firstAppend = stub.append.mock.calls[0]![0] as Record<string, unknown>;
    expect(firstAppend.type).toBe(CF_EVENT_RECEIVED_TYPE);
    expect(firstAppend.idempotencyKey).toBe("cf-event:msg-42");
    expect((firstAppend.payload as Record<string, unknown>).cfType).toBe(
      CF_EVENT_TYPES.REPO_CREATED,
    );
    expect(firstAppend.metadata).toEqual({ cloudflare: cfEvent.metadata });

    expect(message.ack).toHaveBeenCalled();
  });

  test("fan-out: pushed event goes to project repo stream", async () => {
    const stubs = [createMockStub(), createMockStub()];
    let callIndex = 0;
    mockGetInitializedStreamStub.mockImplementation(async () => stubs[callIndex++] as never);

    const cfEvent = {
      type: CF_EVENT_TYPES.PUSHED,
      source: { type: "artifacts.repo", namespace: "ns", repo_name: "proj-1--my-repo" },
      payload: {
        ref: "refs/heads/main",
        before: "aaa",
        after: "bbb",
        commits: [
          {
            id: "bbb",
            message: "Fix bug",
            messageTruncated: false,
            timestamp: "2026-05-19T00:00:00Z",
            author: { name: "Dev", email: "dev@test.com" },
            committer: { name: "Dev", email: "dev@test.com" },
            parents: ["aaa"],
          },
        ],
        totalCommitsCount: 1,
        commitsTruncated: false,
      },
      metadata: { accountId: "acct-1" },
    };

    const message = createMockMessage(cfEvent, "msg-pushed");
    await handleArtifactEventsBatch(createMockBatch([message]), mockEnv);

    // Second call = fan-out to project repo stream
    expect(mockGetInitializedStreamStub).toHaveBeenCalledTimes(2);
    const secondCallArgs = mockGetInitializedStreamStub.mock.calls[1]![0] as Record<
      string,
      unknown
    >;
    expect(secondCallArgs.namespace).toBe("proj-1");
    expect(secondCallArgs.path).toBe("/repos/my-repo");

    const secondAppend = stubs[1]!.append.mock.calls[0]![0] as Record<string, unknown>;
    expect(secondAppend.type).toBe(REPO_PUSHED_TYPE);
    expect(secondAppend.idempotencyKey).toBe("cf-event-fanout:msg-pushed");

    const payload = secondAppend.payload as Record<string, unknown>;
    expect(payload.ref).toBe("refs/heads/main");
    expect(payload.before).toBe("aaa");
    expect(payload.after).toBe("bbb");
    expect(payload.totalCommits).toBe(1);
    expect(payload.cfPayload).toBeDefined();
  });

  test("fan-out: account-level event goes to global repos stream", async () => {
    const stubs = [createMockStub(), createMockStub()];
    let callIndex = 0;
    mockGetInitializedStreamStub.mockImplementation(async () => stubs[callIndex++] as never);

    const cfEvent = {
      type: CF_EVENT_TYPES.REPO_CREATED,
      source: { type: "artifacts", repo_name: "proj-1--my-repo" },
      payload: { repoId: "abc", defaultBranch: "main" },
    };

    const message = createMockMessage(cfEvent, "msg-created");
    await handleArtifactEventsBatch(createMockBatch([message]), mockEnv);

    // Second call = fan-out to global repos stream
    const secondCallArgs = mockGetInitializedStreamStub.mock.calls[1]![0] as Record<
      string,
      unknown
    >;
    expect(secondCallArgs.namespace).toBe("os-prd-global");
    expect(secondCallArgs.path).toBe("/repos");

    const secondAppend = stubs[1]!.append.mock.calls[0]![0] as Record<string, unknown>;
    expect(secondAppend.type).toBe(REPO_ARTIFACT_CREATED_TYPE);
    expect(secondAppend.idempotencyKey).toBe("cf-event-fanout:msg-created");

    const payload = secondAppend.payload as Record<string, unknown>;
    expect(payload.artifactName).toBe("proj-1--my-repo");
    expect(payload.projectId).toBe("proj-1");
    expect(payload.repoSlug).toBe("my-repo");
  });

  test("fan-out: cloned event goes to project repo stream", async () => {
    const stubs = [createMockStub(), createMockStub()];
    let callIndex = 0;
    mockGetInitializedStreamStub.mockImplementation(async () => stubs[callIndex++] as never);

    const cfEvent = {
      type: CF_EVENT_TYPES.CLONED,
      source: { type: "artifacts.repo", namespace: "ns", repo_name: "proj-1--my-repo" },
      payload: {},
    };

    const message = createMockMessage(cfEvent, "msg-cloned");
    await handleArtifactEventsBatch(createMockBatch([message]), mockEnv);

    const secondCallArgs = mockGetInitializedStreamStub.mock.calls[1]![0] as Record<
      string,
      unknown
    >;
    expect(secondCallArgs.namespace).toBe("proj-1");
    expect(secondCallArgs.path).toBe("/repos/my-repo");

    const secondAppend = stubs[1]!.append.mock.calls[0]![0] as Record<string, unknown>;
    expect(secondAppend.type).toBe(REPO_CLONED_TYPE);
  });

  test("fan-out: fetched event goes to project repo stream", async () => {
    const stubs = [createMockStub(), createMockStub()];
    let callIndex = 0;
    mockGetInitializedStreamStub.mockImplementation(async () => stubs[callIndex++] as never);

    const cfEvent = {
      type: CF_EVENT_TYPES.FETCHED,
      source: { type: "artifacts.repo", namespace: "ns", repo_name: "proj-1--my-repo" },
      payload: {},
    };

    const message = createMockMessage(cfEvent, "msg-fetched");
    await handleArtifactEventsBatch(createMockBatch([message]), mockEnv);

    const secondAppend = stubs[1]!.append.mock.calls[0]![0] as Record<string, unknown>;
    expect(secondAppend.type).toBe(REPO_FETCHED_TYPE);
  });

  test("retries message on processing error", async () => {
    mockGetInitializedStreamStub.mockRejectedValue(new Error("stream unavailable"));

    const cfEvent = {
      type: CF_EVENT_TYPES.PUSHED,
      source: { type: "artifacts.repo", repo_name: "proj-1--repo" },
      payload: { ref: "refs/heads/main" },
    };

    const message = createMockMessage(cfEvent, "msg-err");
    await handleArtifactEventsBatch(createMockBatch([message]), mockEnv);

    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  test("acks message with unparseable body", async () => {
    const message = createMockMessage({ not: "a valid event" }, "msg-bad");
    await handleArtifactEventsBatch(createMockBatch([message]), mockEnv);

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  test("handles multiple messages in a batch", async () => {
    const stub = createMockStub();
    mockGetInitializedStreamStub.mockResolvedValue(stub as never);

    const messages = [
      createMockMessage(
        {
          type: CF_EVENT_TYPES.REPO_CREATED,
          source: { type: "artifacts", repo_name: "p--r" },
          payload: { repoId: "a" },
        },
        "msg-1",
      ),
      createMockMessage(
        {
          type: CF_EVENT_TYPES.REPO_DELETED,
          source: { type: "artifacts", repo_name: "p--r" },
          payload: { repoId: "b" },
        },
        "msg-2",
      ),
    ];

    await handleArtifactEventsBatch(createMockBatch(messages), mockEnv);

    expect(messages[0]!.ack).toHaveBeenCalled();
    expect(messages[1]!.ack).toHaveBeenCalled();
  });

  test("derives global namespace from ARTIFACTS_NAMESPACE", async () => {
    const stub = createMockStub();
    mockGetInitializedStreamStub.mockResolvedValue(stub as never);

    const cfEvent = {
      type: CF_EVENT_TYPES.REPO_CREATED,
      source: { type: "artifacts", repo_name: "p--r" },
      payload: { repoId: "x" },
    };

    // Test with different namespace suffixes
    await handleArtifactEventsBatch(createMockBatch([createMockMessage(cfEvent)]), {
      ...mockEnv,
      ARTIFACTS_NAMESPACE: "os-dev-jonas-repos",
    } satisfies ArtifactEventsQueueEnv);

    const callArgs = mockGetInitializedStreamStub.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.namespace).toBe("os-dev-jonas-global");
  });

  test("skips repo-level fan-out when artifact name is unparseable", async () => {
    const stubs = [createMockStub()];
    let callIndex = 0;
    mockGetInitializedStreamStub.mockImplementation(async () => stubs[callIndex++] as never);

    const cfEvent = {
      type: CF_EVENT_TYPES.PUSHED,
      source: { type: "artifacts.repo", repo_name: "no-separator" },
      payload: { ref: "refs/heads/main" },
    };

    const message = createMockMessage(cfEvent, "msg-bad-name");
    await handleArtifactEventsBatch(createMockBatch([message]), mockEnv);

    // Only one call (the global event), no fan-out
    expect(mockGetInitializedStreamStub).toHaveBeenCalledTimes(1);
    expect(message.ack).toHaveBeenCalled();
  });
});
