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
) {
  return new CapabilityProviderPagerRelay({
    env: { STREAM: { getByName: () => durableObject } } as never,
    scope: { path: "/", projectId: "project" },
    waitUntil,
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
