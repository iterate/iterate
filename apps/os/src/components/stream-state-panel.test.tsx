// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AgentUiPresenceEntry } from "@iterate-com/ui/components/events/agent-ui-reducer";

vi.mock("@iterate-com/ui/components/sheet", () => ({
  Sheet: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <>{children}</> : null,
  SheetContent: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@iterate-com/ui/components/serialized-object-code-block", () => ({
  SerializedObjectCodeBlock: ({ data }: { data: unknown }) => (
    <div data-testid="serialized-state">{JSON.stringify(data)}</div>
  ),
}));

import {
  StreamStatePanel,
  type StreamRuntimePanelState,
  type StreamRuntimeLiveSnapshot,
  type StreamRuntimeLiveViewSource,
} from "./stream-state-panel.tsx";

const mountedRoots: Array<ReturnType<typeof createRoot>> = [];
const reactEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

beforeEach(() => {
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

test("a pushed runtime update does not reload or blank a focused processor snapshot", async () => {
  const streamRuntimeLive = fakeRuntimeLiveSource(streamRuntimeState(5));

  const neverResolvingRefresh = new Promise<never>(() => {});
  const getProcessorRuntimeState = vi
    .fn()
    .mockResolvedValueOnce({
      snapshot: { offset: 5, state: { stable: true } },
      runtime: null,
    })
    .mockReturnValue(neverResolvingRefresh);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);

  await act(async () => {
    root.render(
      <StreamStatePanel
        open
        onOpenChange={() => {}}
        presence={[processorPresence]}
        metrics={emptyMetrics}
        eventCount={5}
        busy={false}
        focusedKey={processorPresence.subscriptionKey}
        onFocus={() => {}}
        onBack={() => {}}
        onClose={() => {}}
        onClearClientDatabase={async () => {}}
        getProcessorRuntimeState={getProcessorRuntimeState}
        streamRuntimeLive={streamRuntimeLive}
      />,
    );
  });

  await vi.waitFor(() => {
    expect(host.querySelector("[data-testid=serialized-state]")?.textContent).toBe(
      '{"stable":true}',
    );
  });
  expect(getProcessorRuntimeState).toHaveBeenCalledTimes(1);

  await act(async () => {
    streamRuntimeLive.push(streamRuntimeState(6));
  });

  expect(getProcessorRuntimeState).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain("Loading reduced state");
  expect(host.querySelector("[data-testid=serialized-state]")?.textContent).toBe('{"stable":true}');

  const refreshButton = host.querySelector<HTMLButtonElement>(
    'button[title="Refresh reduced state"]',
  );
  expect(refreshButton).not.toBeNull();
  await act(async () => {
    refreshButton?.click();
    await Promise.resolve();
  });

  expect(getProcessorRuntimeState).toHaveBeenCalledTimes(2);
  expect(refreshButton?.disabled).toBe(true);
  expect(host.textContent).not.toContain("Loading reduced state");
  expect(host.querySelector("[data-testid=serialized-state]")?.textContent).toBe('{"stable":true}');
});

test("the runtime LiveState is observed only while the sheet is open", async () => {
  const streamRuntimeLive = fakeRuntimeLiveSource(streamRuntimeState(5));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);

  const render = (open: boolean) =>
    root.render(
      <StreamStatePanel
        open={open}
        onOpenChange={() => {}}
        presence={[]}
        metrics={emptyMetrics}
        eventCount={5}
        busy={false}
        focusedKey={null}
        onFocus={() => {}}
        onBack={() => {}}
        onClose={() => {}}
        onClearClientDatabase={async () => {}}
        getProcessorRuntimeState={async () => null}
        streamRuntimeLive={streamRuntimeLive}
      />,
    );

  await act(async () => render(false));
  expect(streamRuntimeLive.observerCount()).toBe(0);

  await act(async () => render(true));
  expect(streamRuntimeLive.observerCount()).toBe(1);

  await act(async () => render(false));
  expect(streamRuntimeLive.observerCount()).toBe(0);
});

test("the live runtime table removes an event-sourced ghost ephemeral consumer", async () => {
  const streamRuntimeLive = fakeRuntimeLiveSource(streamRuntimeState(5));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);

  await act(async () => {
    root.render(
      <StreamStatePanel
        open
        onOpenChange={() => {}}
        presence={[processorPresence]}
        metrics={emptyMetrics}
        eventCount={5}
        busy={false}
        focusedKey={null}
        onFocus={() => {}}
        onBack={() => {}}
        onClose={() => {}}
        onClearClientDatabase={async () => {}}
        getProcessorRuntimeState={async () => null}
        streamRuntimeLive={streamRuntimeLive}
      />,
    );
  });

  expect(host.textContent).toContain("connected ephemeral");

  await act(async () => {
    streamRuntimeLive.push(streamRuntimeState(6, false));
  });

  expect(host.textContent).not.toContain("connected ephemeral");
  expect(host.textContent).toContain("No ephemeral consumers are connected.");
});

test("the throughput presentation clock stops after the 60-second series is empty", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
  try {
    const streamRuntimeLive = fakeRuntimeLiveSource(
      streamRuntimeState(5, true, "2026-07-18T12:00:00.000Z"),
    );
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.push(root);

    await act(async () => {
      root.render(
        <StreamStatePanel
          open
          onOpenChange={() => {}}
          presence={[]}
          metrics={emptyMetrics}
          eventCount={5}
          busy={false}
          focusedKey={null}
          onFocus={() => {}}
          onBack={() => {}}
          onClose={() => {}}
          onClearClientDatabase={async () => {}}
          getProcessorRuntimeState={async () => null}
          streamRuntimeLive={streamRuntimeLive}
        />,
      );
      await Promise.resolve();
    });

    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

const processorPresence: AgentUiPresenceEntry = {
  subscriptionKey: "processor:test",
  direction: "outbound",
  connected: true,
  processor: {
    slug: "test",
    version: "1.0.0",
    description: "Test processor",
    consumes: [],
    emits: [],
    ownedEvents: [],
  },
};

const emptyMetrics = {
  spark: [],
  transportRttMs: null,
  subscriber: undefined,
};

function streamRuntimeState(
  maxOffset: number,
  connected = true,
  reportedAt = "2026-07-18T00:00:00.000Z",
): StreamRuntimePanelState {
  return {
    coreProcessorState: { maxOffset },
    runtime: {
      connections: connected
        ? {
            [processorPresence.subscriptionKey]: {
              subscriptionType: "ephemeral",
              subscriber: { processor: { announcement: processorPresence.processor } },
            },
          }
        : {},
      subscriptions: {},
      metrics: {
        measuredSince: "2026-07-18T00:00:00.000Z",
        reportedAt,
        ingress: {
          bytesPerSecond5s: 0,
          perSecond5s: 0,
          series: { counts: [], bytes: [] },
        },
        egress: {
          bytesPerSecond5s: 0,
          perSecond5s: 0,
          series: { counts: [], bytes: [] },
        },
      },
      storageSizeBytes: 0,
    },
  } as unknown as StreamRuntimePanelState;
}

function fakeRuntimeLiveSource(initial: StreamRuntimePanelState) {
  let snapshot: StreamRuntimeLiveSnapshot = {
    value: initial,
    status: "live",
    error: undefined,
    refreshing: false,
  };
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    refresh: vi.fn(),
    push(value: StreamRuntimePanelState) {
      snapshot = { value, status: "live", error: undefined, refreshing: false };
      for (const listener of listeners) listener();
    },
    observerCount: () => listeners.size,
  } satisfies StreamRuntimeLiveViewSource & {
    push(value: StreamRuntimePanelState): void;
    observerCount(): number;
  };
}
