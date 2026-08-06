import { afterEach, describe, expect, it, vi } from "vitest";
import { internalStreamId } from "./domains/streams/stream-delivery-utils.ts";

const getEvent = vi.hoisted(() => vi.fn());
const waitForEvent = vi.hoisted(() => vi.fn());
const snapshot = vi.hoisted(() => vi.fn());
const waitUntilProcessed = vi.hoisted(() => vi.fn());

vi.mock("./env.ts", () => ({
  itxEnv: {
    STREAM: {
      getByName: () => ({ getEvent, waitForEvent }),
    },
    PROJECT: {
      getByName: () => ({ processor: { snapshot, waitUntilProcessed } }),
    },
  },
  workerVersion: () => "test-version",
}));

const { ProjectRpcTarget } = await import("./rpc-targets.ts");

describe("ProjectRpcTarget waitUntilCreated", () => {
  afterEach(() => {
    vi.useRealTimers();
    getEvent.mockReset();
    waitForEvent.mockReset();
    snapshot.mockReset();
    waitUntilProcessed.mockReset();
  });

  it("bounds the initial creation-request read by the public timeout", async () => {
    vi.useFakeTimers();
    getEvent.mockReturnValue(new Promise(() => undefined));
    const target = new ProjectRpcTarget({
      auth: { assertCanAccessProject: vi.fn() },
      capabilityHost: { path: "/" },
      ctx: { waitUntil: vi.fn() },
      streamContext: { kind: "scope", scopePath: "/" },
      projectId: "prj_preview",
    } as never);

    const waiting = target.waitUntilCreated({ timeoutMs: 100 });
    const rejection = expect(waiting).rejects.toThrow("Project creation timed out after 100ms.");
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(getEvent).toHaveBeenCalledOnce();
  });

  it("reacquires the terminal creation wait after the Stream Durable Object resets", async () => {
    const createRequest = {
      type: "events.iterate.com/project/create-requested",
      offset: 1,
      payload: {
        config: {
          creatorEmail: "owner@example.com",
          onboardingActive: true,
          slug: "preview",
        },
      },
    };
    const created = {
      type: "events.iterate.com/project/created",
      offset: 2,
      path: "/",
      idempotencyKey: internalStreamId("project-creation-terminal", "prj_preview", "created"),
      payload: {
        ...createRequest.payload,
        createRequestedAtOffset: createRequest.offset,
      },
    };
    getEvent.mockResolvedValue(createRequest);
    waitForEvent
      .mockRejectedValueOnce(
        new Error(
          "stream-unavailable: Internal error in Durable Object storage caused object to be reset",
        ),
      )
      .mockResolvedValueOnce(created);
    snapshot.mockResolvedValue({});
    waitUntilProcessed.mockResolvedValue(undefined);
    const target = new ProjectRpcTarget({
      auth: { assertCanAccessProject: vi.fn() },
      capabilityHost: { path: "/" },
      ctx: { waitUntil: vi.fn() },
      streamContext: { kind: "scope", scopePath: "/" },
      projectId: "prj_preview",
    } as never);

    await expect(target.waitUntilCreated({ timeoutMs: 1_000 })).resolves.toBeUndefined();

    expect(waitForEvent).toHaveBeenCalledTimes(2);
    expect(waitUntilProcessed).toHaveBeenCalledWith({ offset: 2, timeoutMs: expect.any(Number) });
  });

  it("propagates a second Stream lifecycle failure instead of retrying forever", async () => {
    getEvent.mockResolvedValue({
      type: "events.iterate.com/project/create-requested",
      offset: 1,
      payload: { config: { slug: "preview" } },
    });
    waitForEvent.mockRejectedValue(
      new Error(
        "stream-unavailable: Internal error in Durable Object storage caused object to be reset",
      ),
    );
    snapshot.mockResolvedValue({});
    const target = new ProjectRpcTarget({
      auth: { assertCanAccessProject: vi.fn() },
      capabilityHost: { path: "/" },
      ctx: { waitUntil: vi.fn() },
      streamContext: { kind: "scope", scopePath: "/" },
      projectId: "prj_preview",
    } as never);

    await expect(target.waitUntilCreated({ timeoutMs: 1_000 })).rejects.toThrow(
      "stream-unavailable:",
    );
    expect(waitForEvent).toHaveBeenCalledTimes(2);
  });
});
