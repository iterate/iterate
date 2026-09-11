// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CapnWebProvider, useLiveState } from "./react.tsx";
import type { LiveUpdate } from "./live-state/protocol.ts";

type State = { name: string };

function makeRoot() {
  const sinks: Array<(update: LiveUpdate<State>) => unknown> = [];
  const disposeHandle = vi.fn();
  const disposeRoot = vi.fn();
  const unsubscribe = vi.fn();
  let onBroken: ((error?: unknown) => void) | undefined;
  const root = {
    [Symbol.dispose]: disposeRoot,
    liveState: {
      get: async () => ({ name: "" }),
      subscribe: async (sink: (update: LiveUpdate<State>) => unknown) => {
        sinks.push(sink);
        return {
          [Symbol.dispose]: disposeHandle,
          ping: () => true,
          unsubscribe,
        };
      },
    },
    onRpcBroken(callback: (error?: unknown) => void) {
      onBroken = callback;
    },
  };
  return {
    breakConnection: () => onBroken?.(new Error("transport closed")),
    disposeHandle,
    disposeRoot,
    push(name: string) {
      const sink = sinks.at(-1);
      if (sink === undefined) throw new Error("live-state subscription is not ready");
      sink({ revision: 0, state: { name }, type: "snapshot" });
    },
    root,
    unsubscribe,
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("generic Cap'n Web live state", () => {
  test("the provider reconnects, owns roots, and keeps the last value through the gap", async () => {
    vi.useFakeTimers();
    const first = makeRoot();
    const second = makeRoot();
    const replacement = Promise.withResolvers<typeof second.root>();
    const makeConnection = vi
      .fn<() => typeof first.root | Promise<typeof second.root>>()
      .mockReturnValueOnce(first.root)
      .mockReturnValueOnce(replacement.promise);

    function Harness() {
      const { status, value } = useLiveState(
        (root: typeof first.root) => root.liveState,
        (state) => state.name,
      );
      return createElement("output", { "data-status": status }, value ?? "∅");
    }

    const container = document.body.appendChild(document.createElement("div"));
    const reactRoot = createRoot(container);
    const rendered = () => container.querySelector("output");
    await act(async () => {
      reactRoot.render(createElement(CapnWebProvider, { makeConnection }, createElement(Harness)));
    });
    await act(async () => first.push("alpha"));
    expect(rendered()?.textContent).toBe("alpha");
    expect(rendered()?.getAttribute("data-status")).toBe("live");

    await act(async () => first.breakConnection());
    expect(first.disposeHandle).toHaveBeenCalledTimes(1);
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    expect(first.disposeRoot).toHaveBeenCalledTimes(1);
    expect(rendered()?.textContent).toBe("alpha");
    expect(rendered()?.getAttribute("data-status")).toBe("connecting");

    await act(async () => vi.advanceTimersByTimeAsync(250));
    await act(async () => replacement.resolve(second.root));
    expect(rendered()?.textContent).toBe("alpha");
    expect(rendered()?.getAttribute("data-status")).toBe("live");
    await act(async () => second.push("beta"));
    expect(rendered()?.textContent).toBe("beta");

    await act(async () => reactRoot.unmount());
    expect(second.disposeHandle).toHaveBeenCalledTimes(1);
    expect(second.disposeRoot).toHaveBeenCalledTimes(1);
    expect(second.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test("an explicit root is borrowed while its subscription remains hook-owned", async () => {
    const borrowed = makeRoot();
    const unusedConnection = vi.fn(() => makeRoot().root);

    function Harness() {
      const { value } = useLiveState(
        (root: typeof borrowed.root) => root.liveState,
        (state) => state.name,
        [],
        { makeConnection: unusedConnection, root: borrowed.root },
      );
      return createElement("output", null, value ?? "∅");
    }

    const container = document.body.appendChild(document.createElement("div"));
    const reactRoot = createRoot(container);
    await act(async () => reactRoot.render(createElement(Harness)));
    await act(async () => borrowed.push("alpha"));
    expect(container.querySelector("output")?.textContent).toBe("alpha");
    await act(async () => reactRoot.unmount());

    expect(borrowed.disposeHandle).toHaveBeenCalledTimes(1);
    expect(borrowed.disposeRoot).not.toHaveBeenCalled();
    expect(borrowed.unsubscribe).toHaveBeenCalledTimes(1);
    expect(unusedConnection).not.toHaveBeenCalled();
  });
});

test("retries a rejected subscription, then becomes live", async () => {
  vi.useFakeTimers();
  const connection = makeRoot();
  const subscribe = vi
    .spyOn(connection.root.liveState, "subscribe")
    .mockRejectedValueOnce(new Error("Pager seed closed"));

  function Harness() {
    const { status } = useLiveState(
      (root: typeof connection.root) => root.liveState,
      (state) => state.name,
    );
    return createElement("output", { "data-status": status });
  }

  const container = document.body.appendChild(document.createElement("div"));
  const reactRoot = createRoot(container);
  await act(async () => {
    reactRoot.render(
      createElement(
        CapnWebProvider,
        { makeConnection: () => connection.root },
        createElement(Harness),
      ),
    );
  });
  await act(async () => {});
  expect(container.querySelector("output")?.getAttribute("data-status")).toBe("error");

  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(subscribe).toHaveBeenCalledTimes(2);
  expect(container.querySelector("output")?.getAttribute("data-status")).toBe("live");

  await act(async () => reactRoot.unmount());
});

test("bounds terminal retries per logical subscription", async () => {
  vi.useFakeTimers();
  const connection = makeRoot();
  const subscribe = vi
    .spyOn(connection.root.liveState, "subscribe")
    .mockRejectedValue(new Error("permanent subscription failure"));

  function Harness({ facet }: { facet: string }) {
    const { status } = useLiveState(
      (root: typeof connection.root) => root.liveState,
      (state) => state.name,
      [facet],
    );
    return createElement("output", { "data-status": status });
  }

  const container = document.body.appendChild(document.createElement("div"));
  const reactRoot = createRoot(container);
  const render = async (facet: string) => {
    await act(async () => {
      reactRoot.render(
        createElement(
          CapnWebProvider,
          { makeConnection: () => connection.root },
          createElement(Harness, { facet }),
        ),
      );
    });
  };
  await render("agents");
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(subscribe).toHaveBeenCalledTimes(3);
  expect(container.querySelector("output")?.getAttribute("data-status")).toBe("error");

  await render("tasks");
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(subscribe).toHaveBeenCalledTimes(6);

  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(subscribe).toHaveBeenCalledTimes(6);
  await act(async () => reactRoot.unmount());
});
