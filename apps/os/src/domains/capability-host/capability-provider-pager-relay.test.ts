import { beforeEach, describe, expect, it, vi } from "vitest";

const { dialPager } = vi.hoisted(() => ({ dialPager: vi.fn() }));

vi.mock("../hibernatable-pager.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hibernatable-pager.ts")>()),
  dialHibernatablePager: dialPager,
}));

import { CapabilityProviderPagerRelay } from "./capability-provider-pager-relay.ts";
import type { CapabilityProvidedPayload } from "./types.ts";

class FakePager extends EventTarget {
  readonly closed: { code?: number; reason?: string }[] = [];

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
  }

  page(page: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(page) }));
  }

  disconnect(): void {
    this.dispatchEvent(new Event("close"));
  }
}

type LiveCapabilityProvidedPayload = Extract<CapabilityProvidedPayload, { type: "live" }>;

function makeDurableObject(overrides: Record<string, unknown> = {}) {
  let nextProvidedAtOffset = 7;
  return {
    activateLiveCapability: vi.fn(async () => ({ [Symbol.dispose]: vi.fn() })),
    connectCapabilityProviderPager: vi.fn(async () => 5),
    provideCapability: vi.fn(async (record: LiveCapabilityProvidedPayload) => ({
      path: record.path,
      providedAtOffset: nextProvidedAtOffset++,
    })),
    revokeCapability: vi.fn(async () => undefined),
    ...overrides,
  };
}

function relayOver(
  durableObject: ReturnType<typeof makeDurableObject>,
  waitUntil: (promise: Promise<unknown>) => void = () => undefined,
  onPagerLost?: () => void,
) {
  return new CapabilityProviderPagerRelay({
    env: { STREAM: { getByName: () => durableObject } } as never,
    scope: { path: "/", projectId: "project" },
    waitUntil,
    ...(onPagerLost === undefined ? {} : { onPagerLost }),
  });
}

describe("CapabilityProviderPagerRelay", () => {
  beforeEach(() => {
    dialPager.mockReset();
  });

  it("mounts multiple providers through one connected Pager offset", async () => {
    const pager = new FakePager();
    dialPager.mockResolvedValue(pager);
    const durableObject = makeDurableObject();
    const relay = relayOver(durableObject);

    const [first, second] = await Promise.all([
      relay.provide({ capability: { value: () => "first" }, path: ["first"], type: "live" }),
      relay.provide({ capability: { value: () => "second" }, path: ["second"], type: "live" }),
    ]);

    expect(dialPager).toHaveBeenCalledOnce();
    const pagerDialId = dialPager.mock.calls[0]?.[0].headerValue.pagerDialId as string;
    expect(durableObject.connectCapabilityProviderPager).toHaveBeenCalledExactlyOnceWith({
      pagerDialId,
    });
    expect(durableObject.provideCapability).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ path: ["first"], providerPager: { connectedAtOffset: 5 } }),
    );
    expect(durableObject.provideCapability).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ path: ["second"], providerPager: { connectedAtOffset: 5 } }),
    );
    expect(first.isActive()).toBe(true);
    expect(second.isActive()).toBe(true);
  });

  it("activates and idles one requested mount without disturbing its sibling", async () => {
    const pager = new FakePager();
    dialPager.mockResolvedValue(pager);
    const firstLegDispose = vi.fn();
    const durableObject = makeDurableObject({
      activateLiveCapability: vi.fn(async () => ({ [Symbol.dispose]: firstLegDispose })),
    });
    const background: Promise<unknown>[] = [];
    const relay = relayOver(durableObject, (promise) => background.push(promise));
    const first = await relay.provide({
      capability: { echo: (value: string) => value },
      path: ["first"],
      type: "live",
    });
    const second = await relay.provide({
      capability: { echo: (value: string) => value },
      path: ["second"],
      type: "live",
    });

    pager.page({ type: "activate", providedAtOffset: first.providedAtOffset });
    await vi.waitFor(() => expect(durableObject.activateLiveCapability).toHaveBeenCalledOnce());
    expect(durableObject.activateLiveCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        connectedAtOffset: 5,
        providedAtOffset: first.providedAtOffset,
      }),
    );
    pager.page({ type: "idle", providedAtOffset: first.providedAtOffset });
    await vi.waitFor(() => expect(firstLegDispose).toHaveBeenCalledOnce());
    await expect(Promise.all(background)).resolves.toEqual([undefined, undefined]);
    expect(first.isActive()).toBe(true);
    expect(second.isActive()).toBe(true);
  });

  it("retires one mount while leaving its sibling and Pager active", async () => {
    const pager = new FakePager();
    dialPager.mockResolvedValue(pager);
    const durableObject = makeDurableObject();
    const background: Promise<unknown>[] = [];
    const relay = relayOver(durableObject, (promise) => background.push(promise));
    const first = await relay.provide({ capability: {}, path: ["first"], type: "live" });
    const second = await relay.provide({ capability: {}, path: ["second"], type: "live" });

    pager.page({ type: "retire", providedAtOffset: first.providedAtOffset });
    await expect(Promise.all(background)).resolves.toEqual([undefined]);

    expect(first.isActive()).toBe(false);
    expect(second.isActive()).toBe(true);
    expect(pager.closed).toEqual([]);
  });

  it("closes the shared Pager when its final mount retires", async () => {
    const pager = new FakePager();
    dialPager.mockResolvedValue(pager);
    const relay = relayOver(makeDurableObject());
    const first = await relay.provide({ capability: {}, path: ["first"], type: "live" });
    const second = await relay.provide({ capability: {}, path: ["second"], type: "live" });

    await first.revoke({ path: first.path, providedAtOffset: first.providedAtOffset });
    expect(pager.closed).toEqual([]);

    await second.revoke({ path: second.path, providedAtOffset: second.providedAtOffset });
    expect(pager.closed).toEqual([{ code: 1000, reason: "no live capability mounts" }]);
  });

  it("retires every mount when the shared Pager disconnects", async () => {
    const pager = new FakePager();
    dialPager.mockResolvedValue(pager);
    const durableObject = makeDurableObject();
    const background: Promise<unknown>[] = [];
    const relay = relayOver(durableObject, (promise) => background.push(promise));
    const first = await relay.provide({ capability: {}, path: ["first"], type: "live" });
    const second = await relay.provide({ capability: {}, path: ["second"], type: "live" });

    pager.disconnect();
    await expect(Promise.all(background)).resolves.toEqual([undefined]);

    expect(first.isActive()).toBe(false);
    expect(second.isActive()).toBe(false);
    expect(durableObject.revokeCapability).not.toHaveBeenCalled();
  });

  it("reports a far-side Pager loss exactly once, so the session owner can tear down", async () => {
    const pager = new FakePager();
    dialPager.mockResolvedValue(pager);
    const background: Promise<unknown>[] = [];
    const onPagerLost = vi.fn();
    const relay = relayOver(
      makeDurableObject(),
      (promise) => background.push(promise),
      onPagerLost,
    );
    await relay.provide({ capability: {}, path: ["first"], type: "live" });
    await relay.provide({ capability: {}, path: ["second"], type: "live" });

    pager.disconnect();
    await Promise.all(background);

    expect(onPagerLost).toHaveBeenCalledTimes(1);
  });

  it("never reports Pager loss for its own deliberate closes", async () => {
    const pager = new FakePager();
    dialPager.mockResolvedValue(pager);
    const background: Promise<unknown>[] = [];
    const onPagerLost = vi.fn();
    const relay = relayOver(
      makeDurableObject(),
      (promise) => background.push(promise),
      onPagerLost,
    );
    const only = await relay.provide({ capability: {}, path: ["only"], type: "live" });

    // Revoking the final mount closes the Pager from OUR side...
    await only.revoke({ path: only.path, providedAtOffset: only.providedAtOffset });
    expect(pager.closed).toEqual([{ code: 1000, reason: "no live capability mounts" }]);
    // ...and even when that close comes back as an event, it is not a loss.
    pager.disconnect();
    await Promise.all(background);

    expect(onPagerLost).not.toHaveBeenCalled();
  });

  it("marks only a call interrupted by its own closed Pager as capability-offline", async () => {
    const pager = new FakePager();
    dialPager.mockResolvedValue(pager);
    let invoker: { invoke(path: string[], args: unknown[]): Promise<unknown> } | undefined;
    const durableObject = makeDurableObject({
      activateLiveCapability: vi.fn(async (input) => {
        invoker = input.invoker as typeof invoker;
        return { [Symbol.dispose]: vi.fn() };
      }),
    });
    const background: Promise<unknown>[] = [];
    const relay = relayOver(durableObject, (promise) => background.push(promise));
    const interrupted = Promise.withResolvers<unknown>();
    const mounted = await relay.provide({
      capability: { echo: () => interrupted.promise },
      path: ["device"],
      type: "live",
    });
    pager.page({ type: "activate", providedAtOffset: mounted.providedAtOffset });
    await vi.waitFor(() => expect(invoker).toBeDefined());

    const invocation = invoker!.invoke(["echo"], []);
    pager.disconnect();
    interrupted.reject(new Error("remote WebSocket terminated"));

    await expect(invocation).rejects.toThrow('capability "device" is offline');
    await Promise.all(background);
  });

  it("preserves an application error while the Pager generation remains live", async () => {
    const pager = new FakePager();
    dialPager.mockResolvedValue(pager);
    let invoker: { invoke(path: string[], args: unknown[]): Promise<unknown> } | undefined;
    const durableObject = makeDurableObject({
      activateLiveCapability: vi.fn(async (input) => {
        invoker = input.invoker as typeof invoker;
        return { [Symbol.dispose]: vi.fn() };
      }),
    });
    const background: Promise<unknown>[] = [];
    const relay = relayOver(durableObject, (promise) => background.push(promise));
    const mounted = await relay.provide({
      capability: { echo: () => Promise.reject(new Error("application failure")) },
      path: ["device"],
      type: "live",
    });
    pager.page({ type: "activate", providedAtOffset: mounted.providedAtOffset });
    await vi.waitFor(() => expect(invoker).toBeDefined());

    await expect(invoker!.invoke(["echo"], [])).rejects.toThrow("application failure");
    await Promise.all(background);
  });

  it("preserves a provider error that settles before a same-turn Pager close", async () => {
    const pager = new FakePager();
    dialPager.mockResolvedValue(pager);
    let invoker: { invoke(path: string[], args: unknown[]): Promise<unknown> } | undefined;
    const durableObject = makeDurableObject({
      activateLiveCapability: vi.fn(async (input) => {
        invoker = input.invoker as typeof invoker;
        return { [Symbol.dispose]: vi.fn() };
      }),
    });
    const background: Promise<unknown>[] = [];
    const relay = relayOver(durableObject, (promise) => background.push(promise));
    const providerResult = Promise.withResolvers<unknown>();
    const mounted = await relay.provide({
      capability: { echo: () => providerResult.promise },
      path: ["device"],
      type: "live",
    });
    pager.page({ type: "activate", providedAtOffset: mounted.providedAtOffset });
    await vi.waitFor(() => expect(invoker).toBeDefined());

    const invocation = invoker!.invoke(["echo"], []);
    const assertion = expect(invocation).rejects.toThrow("application failure");
    // Let the provider's rejection cross the retained-capability adapter
    // before closing the Pager. That first outcome remains an application
    // fact, even if the transport falls away immediately afterwards.
    providerResult.reject(new Error("application failure"));
    await Promise.resolve();
    await Promise.resolve();
    pager.disconnect();

    await assertion;
    await Promise.all(background);
  });

  it("maps a later call offline after completed calls", async () => {
    const pager = new FakePager();
    dialPager.mockResolvedValue(pager);
    let invoker: { invoke(path: string[], args: unknown[]): Promise<unknown> } | undefined;
    const durableObject = makeDurableObject({
      activateLiveCapability: vi.fn(async (input) => {
        invoker = input.invoker as typeof invoker;
        return { [Symbol.dispose]: vi.fn() };
      }),
    });
    const background: Promise<unknown>[] = [];
    const relay = relayOver(durableObject, (promise) => background.push(promise));
    const echo = vi.fn((value: number) => value);
    const mounted = await relay.provide({ capability: { echo }, path: ["device"], type: "live" });
    pager.page({ type: "activate", providedAtOffset: mounted.providedAtOffset });
    await vi.waitFor(() => expect(invoker).toBeDefined());

    await expect(invoker!.invoke(["echo"], [1])).resolves.toBe(1);
    await expect(invoker!.invoke(["echo"], [2])).resolves.toBe(2);
    pager.disconnect();
    await expect(invoker!.invoke(["echo"], [3])).rejects.toThrow('capability "device" is offline');
    expect(echo).toHaveBeenCalledTimes(2);
    await Promise.all(background);
  });

  it("preserves a synchronous provider throw before the Pager closes", async () => {
    const pager = new FakePager();
    dialPager.mockResolvedValue(pager);
    let invoker: { invoke(path: string[], args: unknown[]): Promise<unknown> } | undefined;
    const durableObject = makeDurableObject({
      activateLiveCapability: vi.fn(async (input) => {
        invoker = input.invoker as typeof invoker;
        return { [Symbol.dispose]: vi.fn() };
      }),
    });
    const relay = relayOver(durableObject);
    const mounted = await relay.provide({
      capability: {
        echo() {
          throw new Error("synchronous application failure");
        },
      },
      path: ["device"],
      type: "live",
    });
    pager.page({ type: "activate", providedAtOffset: mounted.providedAtOffset });
    await vi.waitFor(() => expect(invoker).toBeDefined());

    await expect(invoker!.invoke(["echo"], [])).rejects.toThrow("synchronous application failure");
  });

  it("releases a disposable plain provider result before forwarding it", async () => {
    const pager = new FakePager();
    dialPager.mockResolvedValue(pager);
    let invoker: { invoke(path: string[], args: unknown[]): Promise<unknown> } | undefined;
    const durableObject = makeDurableObject({
      activateLiveCapability: vi.fn(async (input) => {
        invoker = input.invoker as typeof invoker;
        return { [Symbol.dispose]: vi.fn() };
      }),
    });
    const relay = relayOver(durableObject);
    const dispose = vi.fn();
    const mounted = await relay.provide({
      capability: { health: () => ({ ok: true, [Symbol.dispose]: dispose }) },
      path: ["device"],
      type: "live",
    });
    pager.page({ type: "activate", providedAtOffset: mounted.providedAtOffset });
    await vi.waitFor(() => expect(invoker).toBeDefined());

    await expect(invoker!.invoke(["health"], [])).resolves.toEqual({ ok: true });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("preserves a successful plain result when release throws", async () => {
    const pager = new FakePager();
    dialPager.mockResolvedValue(pager);
    let invoker: { invoke(path: string[], args: unknown[]): Promise<unknown> } | undefined;
    const durableObject = makeDurableObject({
      activateLiveCapability: vi.fn(async (input) => {
        invoker = input.invoker as typeof invoker;
        return { [Symbol.dispose]: vi.fn() };
      }),
    });
    const relay = relayOver(durableObject);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mounted = await relay.provide({
      capability: {
        health: () => ({
          ok: true,
          [Symbol.dispose]: () => {
            throw new Error("release failed");
          },
        }),
      },
      path: ["device"],
      type: "live",
    });
    pager.page({ type: "activate", providedAtOffset: mounted.providedAtOffset });
    await vi.waitFor(() => expect(invoker).toBeDefined());

    await expect(invoker!.invoke(["health"], [])).resolves.toEqual({ ok: true });
    expect(warn).toHaveBeenCalledWith(
      "live provider plain-data result disposal failed",
      expect.objectContaining({ error: expect.any(Error) }),
    );
    warn.mockRestore();
  });

  it("forwards null, undefined, and primitive provider results unchanged", async () => {
    const pager = new FakePager();
    dialPager.mockResolvedValue(pager);
    let invoker: { invoke(path: string[], args: unknown[]): Promise<unknown> } | undefined;
    const durableObject = makeDurableObject({
      activateLiveCapability: vi.fn(async (input) => {
        invoker = input.invoker as typeof invoker;
        return { [Symbol.dispose]: vi.fn() };
      }),
    });
    const relay = relayOver(durableObject);
    const mounted = await relay.provide({
      capability: { nil: () => null, absent: () => undefined, number: () => 42 },
      path: ["device"],
      type: "live",
    });
    pager.page({ type: "activate", providedAtOffset: mounted.providedAtOffset });
    await vi.waitFor(() => expect(invoker).toBeDefined());

    await expect(invoker!.invoke(["nil"], [])).resolves.toBeNull();
    await expect(invoker!.invoke(["absent"], [])).resolves.toBeUndefined();
    await expect(invoker!.invoke(["number"], [])).resolves.toBe(42);
  });

  it("keeps a plain result with a nested capability caller-owned", async () => {
    const pager = new FakePager();
    dialPager.mockResolvedValue(pager);
    let invoker: { invoke(path: string[], args: unknown[]): Promise<unknown> } | undefined;
    const durableObject = makeDurableObject({
      activateLiveCapability: vi.fn(async (input) => {
        invoker = input.invoker as typeof invoker;
        return { [Symbol.dispose]: vi.fn() };
      }),
    });
    const relay = relayOver(durableObject);
    const resultDispose = vi.fn();
    const nestedDispose = vi.fn();
    const result = { nested: { [Symbol.dispose]: nestedDispose }, [Symbol.dispose]: resultDispose };
    const mounted = await relay.provide({
      capability: { getNested: () => result },
      path: ["device"],
      type: "live",
    });
    pager.page({ type: "activate", providedAtOffset: mounted.providedAtOffset });
    await vi.waitFor(() => expect(invoker).toBeDefined());

    await expect(invoker!.invoke(["getNested"], [])).resolves.toBe(result);
    expect(resultDispose).not.toHaveBeenCalled();
    expect(nestedDispose).not.toHaveBeenCalled();
  });

  it("keeps a function-bearing result caller-owned", async () => {
    const pager = new FakePager();
    dialPager.mockResolvedValue(pager);
    let invoker: { invoke(path: string[], args: unknown[]): Promise<unknown> } | undefined;
    const durableObject = makeDurableObject({
      activateLiveCapability: vi.fn(async (input) => {
        invoker = input.invoker as typeof invoker;
        return { [Symbol.dispose]: vi.fn() };
      }),
    });
    const relay = relayOver(durableObject);
    const dispose = vi.fn();
    const callback = Object.assign(() => "still usable", { [Symbol.dispose]: dispose });
    const result = { callback, [Symbol.dispose]: dispose };
    const mounted = await relay.provide({
      capability: { getCallback: () => result },
      path: ["device"],
      type: "live",
    });
    pager.page({ type: "activate", providedAtOffset: mounted.providedAtOffset });
    await vi.waitFor(() => expect(invoker).toBeDefined());

    await expect(invoker!.invoke(["getCallback"], [])).resolves.toBe(result);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("keeps a cyclic plain result caller-owned", async () => {
    const pager = new FakePager();
    dialPager.mockResolvedValue(pager);
    let invoker: { invoke(path: string[], args: unknown[]): Promise<unknown> } | undefined;
    const durableObject = makeDurableObject({
      activateLiveCapability: vi.fn(async (input) => {
        invoker = input.invoker as typeof invoker;
        return { [Symbol.dispose]: vi.fn() };
      }),
    });
    const relay = relayOver(durableObject);
    const dispose = vi.fn();
    const result: { self?: unknown; [Symbol.dispose]: () => void } = { [Symbol.dispose]: dispose };
    result.self = result;
    const mounted = await relay.provide({
      capability: { getCycle: () => result },
      path: ["device"],
      type: "live",
    });
    pager.page({ type: "activate", providedAtOffset: mounted.providedAtOffset });
    await vi.waitFor(() => expect(invoker).toBeDefined());

    await expect(invoker!.invoke(["getCycle"], [])).resolves.toBe(result);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("rolls back only the mount whose activation fails", async () => {
    const pager = new FakePager();
    dialPager.mockResolvedValue(pager);
    const durableObject = makeDurableObject({
      activateLiveCapability: vi.fn(async () => {
        throw new Error("activation broke");
      }),
    });
    const background: Promise<unknown>[] = [];
    const relay = relayOver(durableObject, (promise) => background.push(promise));
    const first = await relay.provide({ capability: {}, path: ["first"], type: "live" });
    const second = await relay.provide({ capability: {}, path: ["second"], type: "live" });

    pager.page({ type: "activate", providedAtOffset: first.providedAtOffset });
    await expect(Promise.all(background)).resolves.toEqual([undefined]);

    expect(durableObject.revokeCapability).toHaveBeenCalledExactlyOnceWith({
      path: ["first"],
      providedAtOffset: first.providedAtOffset,
    });
    expect(first.isActive()).toBe(false);
    expect(second.isActive()).toBe(true);
  });
});
