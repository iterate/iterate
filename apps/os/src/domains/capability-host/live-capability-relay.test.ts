import { beforeEach, describe, expect, it, vi } from "vitest";

const { openSocket } = vi.hoisted(() => ({ openSocket: vi.fn() }));

vi.mock("../hibernatable-rpc-lease.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hibernatable-rpc-lease.ts")>()),
  openHibernatableRpcLeaseSocket: openSocket,
}));

import { LIVE_CAPABILITY_RETIRED_CLOSE_CODE } from "./live-capability-lease.ts";
import { LiveCapabilityProviderRelay } from "./live-capability-relay.ts";
import type { CapabilityProvidedPayload } from "./types.ts";

class FakeSocket extends EventTarget {
  readonly closed: { code?: number; reason?: string }[] = [];

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
  }

  frame(frame: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  disconnect(code: number): void {
    const event = new Event("close");
    Object.defineProperty(event, "code", { value: code });
    this.dispatchEvent(event);
  }
}

type LiveCapabilityProvidedPayload = Extract<CapabilityProvidedPayload, { type: "live" }>;

function makeDurableObject(overrides: Record<string, unknown> = {}) {
  return {
    activateLiveCapability: vi.fn(async () => ({ [Symbol.dispose]: vi.fn() })),
    provideCapability: vi.fn(async (record: LiveCapabilityProvidedPayload) => ({
      path: record.path,
      providedAtOffset: 7,
    })),
    revokeCapability: vi.fn(async () => undefined),
    ...overrides,
  };
}

function relayOver(
  durableObject: ReturnType<typeof makeDurableObject>,
  waitUntil: (promise: Promise<unknown>) => void = () => undefined,
) {
  return new LiveCapabilityProviderRelay({
    env: { CAPABILITY_HOST: { getByName: () => durableObject } } as never,
    scope: { path: "/", projectId: "project" },
    waitUntil,
  });
}

describe("LiveCapabilityProviderRelay", () => {
  beforeEach(() => {
    openSocket.mockReset();
  });

  it("mounts exactly one provider on one socket with only a socketId binding", async () => {
    const socket = new FakeSocket();
    openSocket.mockResolvedValue(socket);
    const durableObject = makeDurableObject();
    const relay = relayOver(durableObject);

    const provision = await relay.provide({
      capability: { value: () => "ok" },
      instructions: "A provider",
      path: ["provider"],
      type: "live",
    });

    expect(openSocket).toHaveBeenCalledOnce();
    const socketId = openSocket.mock.calls[0]?.[0].headerValue.socketId as string;
    expect(durableObject.provideCapability).toHaveBeenCalledExactlyOnceWith(
      {
        flattenNestedPaths: undefined,
        instructions: "A provider",
        path: ["provider"],
        providerBinding: { socketId },
        type: "live",
        types: undefined,
      },
      { socketId },
    );
    expect(provision.isActive()).toBe(true);

    await provision.revoke({ path: provision.path, providedAtOffset: provision.providedAtOffset });
    expect(durableObject.revokeCapability).toHaveBeenCalledExactlyOnceWith({
      path: ["provider"],
      providedAtOffset: 7,
    });
    expect(provision.isActive()).toBe(false);
  });

  it("creates independent sockets for independent provisions", async () => {
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    openSocket.mockResolvedValueOnce(firstSocket).mockResolvedValueOnce(secondSocket);
    const durableObject = makeDurableObject();

    const first = relayOver(durableObject).provide({
      capability: { value: () => "first" },
      path: ["first"],
      type: "live",
    });
    const second = relayOver(durableObject).provide({
      capability: { value: () => "second" },
      path: ["second"],
      type: "live",
    });
    await Promise.all([first, second]);

    expect(openSocket).toHaveBeenCalledTimes(2);
    const bindings = durableObject.provideCapability.mock.calls.map(
      ([record]) => record.providerBinding.socketId,
    );
    expect(new Set(bindings).size).toBe(2);
  });

  it("attaches on wake and releases the short RPC leg on the following idle", async () => {
    const socket = new FakeSocket();
    openSocket.mockResolvedValue(socket);
    const disposeLeg = vi.fn();
    const durableObject = makeDurableObject({
      activateLiveCapability: vi.fn(async () => ({ [Symbol.dispose]: disposeLeg })),
    });
    const background: Promise<unknown>[] = [];
    const provision = await relayOver(durableObject, (promise) => background.push(promise)).provide(
      {
        capability: { echo: (value: string) => value },
        path: ["provider"],
        type: "live",
      },
    );

    socket.frame({ type: "wake" });
    await vi.waitFor(() => expect(durableObject.activateLiveCapability).toHaveBeenCalledOnce());
    expect(durableObject.activateLiveCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        path: ["provider"],
        providedAtOffset: 7,
        socketId: expect.any(String),
      }),
    );
    socket.frame({ type: "idle" });
    await vi.waitFor(() => expect(disposeLeg).toHaveBeenCalledOnce());
    await expect(Promise.all(background)).resolves.toEqual([undefined, undefined]);
    expect(provision.isActive()).toBe(true);
  });

  it("returns an inactive handle when the host retires the committed mount", async () => {
    const socket = new FakeSocket();
    openSocket.mockResolvedValue(socket);
    const durableObject = makeDurableObject();
    const provision = await relayOver(durableObject).provide({
      capability: { value: () => "old" },
      path: ["provider"],
      type: "live",
    });

    socket.disconnect(LIVE_CAPABILITY_RETIRED_CLOSE_CODE);

    expect(provision.isActive()).toBe(false);
    expect(durableObject.revokeCapability).not.toHaveBeenCalled();
  });

  it("exact-revokes a commit whose socket failed before provide returned", async () => {
    const socket = new FakeSocket();
    openSocket.mockResolvedValue(socket);
    let finishCommit!: (provision: { path: string[]; providedAtOffset: number }) => void;
    const durableObject = makeDurableObject({
      provideCapability: vi.fn(
        () =>
          new Promise<{ path: string[]; providedAtOffset: number }>((resolve) => {
            finishCommit = resolve;
          }),
      ),
    });
    const mounting = relayOver(durableObject).provide({
      capability: { value: () => "must not remain mounted" },
      path: ["racing"],
      type: "live",
    });
    await vi.waitFor(() => expect(durableObject.provideCapability).toHaveBeenCalledOnce());

    socket.disconnect(1006);
    finishCommit({ path: ["racing"], providedAtOffset: 9 });

    await expect(mounting).rejects.toThrow("socket closed while mounting");
    expect(durableObject.revokeCapability).toHaveBeenCalledExactlyOnceWith({
      path: ["racing"],
      providedAtOffset: 9,
    });
  });

  it("closes the lease and surfaces an activation plus rollback failure", async () => {
    const socket = new FakeSocket();
    openSocket.mockResolvedValue(socket);
    const durableObject = makeDurableObject({
      activateLiveCapability: vi.fn(async () => {
        throw new Error("attach broke");
      }),
      revokeCapability: vi.fn(async () => {
        throw new Error("rollback broke");
      }),
    });
    const background: Promise<unknown>[] = [];
    const provision = await relayOver(durableObject, (promise) => background.push(promise)).provide(
      {
        capability: { value: () => "broken" },
        path: ["broken"],
        type: "live",
      },
    );

    socket.frame({ type: "wake" });
    await vi.waitFor(() => expect(background).toHaveLength(1));
    await expect(background[0]).rejects.toThrow("activation and rollback failed");
    expect(provision.isActive()).toBe(false);
    expect(socket.closed).toContainEqual({
      code: 1011,
      reason: "live capability relay failed",
    });
  });
});
