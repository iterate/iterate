import { beforeEach, describe, expect, test, vi } from "vitest";
import { handleArtifactEventsBatch } from "./artifact-events-queue-handler.ts";
import type { ArtifactEventsQueueEnv } from "./artifact-events-queue-handler.ts";
import { getInitializedStreamStub } from "~/domains/streams/stream-runtime.ts";

vi.mock("~/domains/streams/stream-runtime.ts", () => ({
  getInitializedStreamStub: vi.fn(),
}));

const mockGetInitializedStreamStub = vi.mocked(getInitializedStreamStub);

const env = {
  GLOBAL_STREAM_NAMESPACE: "os-prd-global",
  STREAM: {} as ArtifactEventsQueueEnv["STREAM"],
};

function createMessage(body: unknown, id: string) {
  return { id, body, ack: vi.fn(), retry: vi.fn(), timestamp: new Date(), attempts: 1 };
}

function createBatch(messages: ReturnType<typeof createMessage>[]) {
  return { queue: "os-prd-artifact-events", messages } as unknown as MessageBatch;
}

describe("handleArtifactEventsBatch", () => {
  const append = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    append.mockResolvedValue({ offset: 1 });
    mockGetInitializedStreamStub.mockResolvedValue({ append } as never);
  });

  test("captures each message verbatim to the global cloudflare events stream", async () => {
    const cfEvent = {
      type: "cf.artifacts.repo.pushed",
      source: { type: "artifacts.repo", namespace: "os-prd-repos", repoName: "proj-1--my-repo" },
      payload: { ref: "refs/heads/main", before: "aaa", after: "bbb" },
      metadata: { accountId: "acct-1", eventSchemaVersion: 1 },
    };
    const message = createMessage(cfEvent, "msg-1");

    await handleArtifactEventsBatch(createBatch([message]), env);

    expect(mockGetInitializedStreamStub).toHaveBeenCalledWith({
      durableObjectNamespace: env.STREAM,
      namespace: "os-prd-global",
      path: "/cloudflare/events",
    });
    expect(append).toHaveBeenCalledWith({
      type: "events.iterate.com/cloudflare/event-received",
      idempotencyKey: "cf-event:msg-1",
      payload: { body: cfEvent },
    });
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  test("captures bodies it cannot interpret instead of dropping them", async () => {
    const message = createMessage({ not: "a known event shape" }, "msg-weird");

    await handleArtifactEventsBatch(createBatch([message]), env);

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { body: { not: "a known event shape" } } }),
    );
    expect(message.ack).toHaveBeenCalled();
  });

  test("retries a message whose append fails and still processes the rest", async () => {
    const failing = createMessage({ type: "cf.artifacts.repo.created" }, "msg-fail");
    const succeeding = createMessage({ type: "cf.artifacts.repo.deleted" }, "msg-ok");
    append.mockRejectedValueOnce(new Error("stream unavailable"));

    await handleArtifactEventsBatch(createBatch([failing, succeeding]), env);

    expect(failing.retry).toHaveBeenCalled();
    expect(failing.ack).not.toHaveBeenCalled();
    expect(succeeding.ack).toHaveBeenCalled();
    expect(succeeding.retry).not.toHaveBeenCalled();
  });
});
