// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock the capnweb session so dialing resolves to a disposable sentinel keyed
// by the socket URL and (post-cutover) the authenticate()/projects.get(id)
// pipeline — we assert on identity/url, never a real RPC session.
vi.mock("capnweb", () => ({
  newWebSocketRpcSession: (ws: { url: string }) => ({
    authenticate: () => {
      const handleFor = (suffix: string) => ({
        url: suffix ? `${ws.url}/${suffix}` : ws.url,
        [Symbol.dispose]: vi.fn(),
      });
      return Object.assign(handleFor(""), {
        projects: { get: (projectId: string) => handleFor(projectId) },
      });
    },
  }),
}));

/** A WebSocket we can drive: record instances, fire open/close by hand. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  private handlers: Record<string, Array<() => void>> = {};
  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, cb: () => void) {
    (this.handlers[type] ??= []).push(cb);
  }
  close() {
    this.fire("close");
  }
  fire(type: string) {
    for (const cb of this.handlers[type] ?? []) cb();
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.resetModules(); // fresh module-level socket Map per test
});
afterEach(() => vi.unstubAllGlobals());

const onlySocket = () => {
  expect(FakeWebSocket.instances).toHaveLength(1);
  return FakeWebSocket.instances[0]!;
};

describe("itx socket map", () => {
  test("connectItx returns the SAME promise per context — one dial, the stable promise use() needs", async () => {
    const { connectItx } = await import("./itx-react.tsx");
    const a = connectItx({ projectId: "acme" });
    expect(connectItx({ projectId: "acme" })).toBe(a);
    expect(FakeWebSocket.instances).toHaveLength(1);
    onlySocket().fire("open");
    await expect(a).resolves.toMatchObject({ url: expect.stringContaining("/api/itx/acme") });
  });

  test("contexts are independent; the global context (no projectId) is its own socket", async () => {
    const { connectItx } = await import("./itx-react.tsx");
    const global = connectItx();
    expect(connectItx({ projectId: "acme" })).not.toBe(global);
    expect(connectItx()).toBe(global);
    expect(FakeWebSocket.instances).toHaveLength(2);
    // One endpoint for every context now — the project narrows client-side.
    expect(FakeWebSocket.instances[0]!.url).toContain("/api/itx");
    expect(FakeWebSocket.instances[1]!.url).toContain("/api/itx");
  });

  test("a closed socket is dropped; the next connectItx dials a fresh one", async () => {
    const { connectItx } = await import("./itx-react.tsx");
    const first = connectItx({ projectId: "acme" });
    onlySocket().fire("open");
    await first;

    FakeWebSocket.instances[0]!.fire("close"); // socket dies
    const second = connectItx({ projectId: "acme" });
    expect(second).not.toBe(first);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test("a dial that closes before opening rejects awaiters instead of hanging", async () => {
    // Regression: a failed/timed-out dial used to leave the cached connecting
    // promise forever-pending, so `await connectItx()` (event handlers,
    // mutationFns) hung. It must reject so imperative callers fail fast.
    const { connectItx } = await import("./itx-react.tsx");
    const first = connectItx({ projectId: "acme" });
    onlySocket().fire("close"); // closed before it ever opened
    await expect(first).rejects.toThrow(/closed before connecting/);

    // The entry was still dropped, so the next connect dials a fresh socket.
    const second = connectItx({ projectId: "acme" });
    expect(second).not.toBe(first);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test("a stale socket's death never drops its successor", async () => {
    const { connectItx } = await import("./itx-react.tsx");
    connectItx({ projectId: "acme" });
    FakeWebSocket.instances[0]!.fire("close"); // first dies → dropped
    const second = connectItx({ projectId: "acme" }); // re-dials
    FakeWebSocket.instances[0]!.fire("close"); // stale repeat — must NOT drop the second
    expect(connectItx({ projectId: "acme" })).toBe(second);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test("reconnectItx disposes the live socket and forces a fresh dial", async () => {
    const { connectItx, reconnectItx } = await import("./itx-react.tsx");
    const first = connectItx({ projectId: "acme" });
    onlySocket().fire("open");
    const session = await first;

    reconnectItx({ projectId: "acme" });
    await Promise.resolve(); // let the dispose .then() run
    expect(session[Symbol.dispose]).toHaveBeenCalledTimes(1);

    expect(connectItx({ projectId: "acme" })).not.toBe(first);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
