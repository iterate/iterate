import { describe, expect, it, vi } from "vitest";

const { openSocket } = vi.hoisted(() => ({
  openSocket: vi.fn(),
}));

vi.mock("../hibernatable-rpc-lease.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hibernatable-rpc-lease.ts")>()),
  openHibernatableRpcLeaseSocket: openSocket,
}));

import { LiveCapabilityProviderChannel } from "./live-capability-relay.ts";

class FakeSocket extends EventTarget {
  readonly closed: { code?: number; reason?: string }[] = [];

  accept(): void {}

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
  }

  frame(frame: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
}

describe("LiveCapabilityProviderChannel", () => {
  it("returns an inactive handle when a simultaneous same-path mount supersedes it", async () => {
    const socket = new FakeSocket();
    openSocket.mockResolvedValue(socket);
    const durableObject = {
      provideCapabilities: vi.fn(
        async (records: { path: string[]; providerBinding?: { leaseKey: string } }[]) => {
          socket.frame({ type: "retire", leaseKey: records[0]?.providerBinding?.leaseKey });
          return records.map(({ path }, index) => ({ path, providedAtOffset: index + 1 }));
        },
      ),
      revokeCapabilities: vi.fn(async () => undefined),
    };
    const channel = new LiveCapabilityProviderChannel({
      env: {
        CAPABILITY_HOST: { getByName: () => durableObject },
      } as never,
      scope: { path: "/", projectId: "project" },
      waitUntil: vi.fn(),
    });

    const firstMount = channel.provide({
      capability: { value: () => "first" },
      path: ["samePath"],
      type: "live",
    });
    const secondMount = channel.provide({
      capability: { value: () => "second" },
      path: ["samePath"],
      type: "live",
    });
    const [first, second] = await Promise.all([firstMount, secondMount]);

    expect(first.isActive()).toBe(false);
    expect(second.isActive()).toBe(true);
    await second.revoke({ path: second.path, providedAtOffset: second.providedAtOffset });
  });

  it("exact-revokes a committed mount when the shared socket closes before provide returns", async () => {
    const socket = new FakeSocket();
    openSocket.mockResolvedValue(socket);
    let finishCommit!: () => void;
    const committed = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    const durableObject = {
      provideCapabilities: vi.fn(async (records: { path: string[] }[]) => {
        await committed;
        return records.map(({ path }, index) => ({ path, providedAtOffset: index + 7 }));
      }),
      revokeCapability: vi.fn(async () => undefined),
      revokeCapabilities: vi.fn(async () => undefined),
    };
    const channel = new LiveCapabilityProviderChannel({
      env: {
        CAPABILITY_HOST: { getByName: () => durableObject },
      } as never,
      scope: { path: "/", projectId: "project" },
      waitUntil: vi.fn(),
    });

    const mounting = channel.provide({
      capability: { value: () => "must not remain mounted" },
      path: ["racing"],
      type: "live",
    });
    await vi.waitFor(() => expect(durableObject.provideCapabilities).toHaveBeenCalledOnce());
    socket.dispatchEvent(new Event("close"));
    finishCommit();

    await expect(mounting).rejects.toThrow("channel closed while mounting");
    expect(durableObject.revokeCapability).toHaveBeenCalledExactlyOnceWith({
      path: ["racing"],
      providedAtOffset: 7,
    });
  });

  it("rejects one malformed mount without poisoning a simultaneous valid batch", async () => {
    const socket = new FakeSocket();
    openSocket.mockResolvedValue(socket);
    const durableObject = {
      provideCapabilities: vi.fn(async (records: { path: string[] }[]) =>
        records.map(({ path }, index) => ({ path, providedAtOffset: index + 1 })),
      ),
      revokeCapabilities: vi.fn(async () => undefined),
    };
    const channel = new LiveCapabilityProviderChannel({
      env: {
        CAPABILITY_HOST: { getByName: () => durableObject },
      } as never,
      scope: { path: "/", projectId: "project" },
      waitUntil: vi.fn(),
    });

    const valid = channel.provide({
      capability: { value: () => "ok" },
      path: ["valid"],
      type: "live",
    });
    const invalid = channel.provide({
      capability: { value: () => "bad" },
      path: ["invalid-path"],
      type: "live",
    });

    await expect(invalid).rejects.toThrow('invalid capability path segment "invalid-path"');
    const provision = await valid;
    expect(durableObject.provideCapabilities).toHaveBeenCalledOnce();
    expect(durableObject.provideCapabilities.mock.calls[0]?.[0]).toMatchObject([
      { path: ["valid"] },
    ]);
    await provision.revoke({ path: provision.path, providedAtOffset: provision.providedAtOffset });
  });

  it("releases the prior leg when a retried wake's attach is refused after idle", async () => {
    const socket = new FakeSocket();
    openSocket.mockResolvedValue(socket);
    const attachResolvers: ((leg: Disposable | undefined) => void)[] = [];
    const durableObject = {
      activateLiveCapability: vi.fn(
        () =>
          new Promise<Disposable | undefined>((resolve) => {
            attachResolvers.push(resolve);
          }),
      ),
      provideCapabilities: vi.fn(async (records: { path: string[] }[]) =>
        records.map(({ path }, index) => ({ path, providedAtOffset: index + 1 })),
      ),
      revokeCapabilities: vi.fn(async () => undefined),
    };
    const channel = new LiveCapabilityProviderChannel({
      env: {
        CAPABILITY_HOST: { getByName: () => durableObject },
      } as never,
      scope: { path: "/", projectId: "project" },
      waitUntil: vi.fn(),
    });
    const provision = await channel.provide({
      capability: { value: () => "ok" },
      path: ["provider"],
      type: "live",
    });

    socket.frame({ type: "wake", leaseKey: expectLeaseKey(durableObject) });
    await vi.waitFor(() => expect(attachResolvers).toHaveLength(1));

    // A consumer retry can issue another wake after the DO's first pending
    // attach timed out, while that first relay->DO RPC is still resolving.
    socket.frame({ type: "wake", leaseKey: expectLeaseKey(durableObject) });
    const disposeFirstLeg = vi.fn();
    attachResolvers[0]!({ [Symbol.dispose]: disposeFirstLeg });
    await vi.waitFor(() => expect(attachResolvers).toHaveLength(2));

    // The first attached invocation drained while attach #2 was outstanding.
    // The DO refuses #2 because it has no pending acquire anymore.
    socket.frame({ type: "idle", leaseKey: expectLeaseKey(durableObject) });
    attachResolvers[1]!(undefined);

    await vi.waitFor(() => expect(disposeFirstLeg).toHaveBeenCalledOnce());
    expect(socket.closed).toEqual([]);
    await provision.revoke({ path: provision.path, providedAtOffset: provision.providedAtOffset });
  });

  it("closes the shared epoch and surfaces a failed attach rollback through waitUntil", async () => {
    const socket = new FakeSocket();
    openSocket.mockResolvedValue(socket);
    const background: Promise<unknown>[] = [];
    const durableObject = {
      activateLiveCapability: vi.fn(async () => {
        throw new Error("attach broke");
      }),
      provideCapabilities: vi.fn(async (records: { path: string[] }[]) =>
        records.map(({ path }, index) => ({ path, providedAtOffset: index + 1 })),
      ),
      revokeCapability: vi.fn(async () => {
        throw new Error("rollback broke");
      }),
      revokeCapabilities: vi.fn(async () => undefined),
    };
    const channel = new LiveCapabilityProviderChannel({
      env: {
        CAPABILITY_HOST: { getByName: () => durableObject },
      } as never,
      scope: { path: "/", projectId: "project" },
      waitUntil: (promise) => background.push(promise),
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const [broken, sibling] = await Promise.all([
        channel.provide({
          capability: { value: () => "broken" },
          path: ["broken"],
          type: "live",
        }),
        channel.provide({
          capability: { value: () => "sibling" },
          path: ["sibling"],
          type: "live",
        }),
      ]);

      socket.frame({ type: "wake", leaseKey: expectLeaseKey(durableObject, 0) });
      await vi.waitFor(() => expect(background).toHaveLength(1));
      await expect(background[0]).rejects.toThrow("attach and rollback failed");
      expect(broken.isActive()).toBe(false);
      expect(sibling.isActive()).toBe(false);
      expect(socket.closed.length).toBeGreaterThan(0);
    } finally {
      logged.mockRestore();
    }
  });
});

function expectLeaseKey(
  durableObject: { provideCapabilities: ReturnType<typeof vi.fn> },
  index = 0,
): string {
  const records = durableObject.provideCapabilities.mock.calls[0]?.[0] as
    | { providerBinding?: { leaseKey?: string } }[]
    | undefined;
  const leaseKey = records?.[index]?.providerBinding?.leaseKey;
  if (leaseKey === undefined) throw new Error("test provision has no lease key");
  return leaseKey;
}
