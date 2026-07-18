// @vitest-environment jsdom

import { act, type ComponentProps, type ReactNode } from "react";
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

import { StreamStatePanel, type StreamRuntimePanelState } from "./stream-state-panel.tsx";

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
  const getProcessorRuntimeState = vi.fn().mockResolvedValue({
    snapshot: { offset: 5, state: { stable: true } },
    runtime: null,
  });
  const { host, root } = mountPanel();
  const render = (streamRuntime: StreamRuntimePanelState) =>
    root.render(
      <StreamStatePanel
        {...panelProps({
          focusedKey: processorPresence.subscriptionKey,
          getProcessorRuntimeState,
          presence: [processorPresence],
          streamRuntime,
        })}
      />,
    );

  await act(async () => render(streamRuntimeState(5)));
  await vi.waitFor(() => {
    expect(host.querySelector("[data-testid=serialized-state]")?.textContent).toBe(
      '{"stable":true}',
    );
  });
  expect(getProcessorRuntimeState).toHaveBeenCalledTimes(1);

  await act(async () => render(streamRuntimeState(6)));

  expect(getProcessorRuntimeState).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain("Loading reduced state");
  expect(host.querySelector("[data-testid=serialized-state]")?.textContent).toBe('{"stable":true}');
});

function mountPanel() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  return { host, root };
}

function panelProps(
  overrides: Partial<ComponentProps<typeof StreamStatePanel>> = {},
): ComponentProps<typeof StreamStatePanel> {
  return {
    open: true,
    onOpenChange: () => {},
    presence: [],
    metrics: emptyMetrics,
    eventCount: 5,
    busy: false,
    focusedKey: null,
    onFocus: () => {},
    onBack: () => {},
    onClose: () => {},
    onClearClientDatabase: async () => {},
    getProcessorRuntimeState: async () => null,
    onRefreshStreamRuntime: () => {},
    streamRuntime: streamRuntimeState(5),
    streamRuntimeError: undefined,
    streamRuntimeFetching: false,
    ...overrides,
  };
}

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

function streamRuntimeState(maxOffset: number): StreamRuntimePanelState {
  return {
    coreProcessorState: { maxOffset },
    runtime: {
      connections: {
        [processorPresence.subscriptionKey]: {
          subscriptionType: "ephemeral",
          subscriber: { processor: { announcement: processorPresence.processor } },
        },
      },
      subscriptions: {},
      metrics: {
        measuredSince: "2026-07-18T00:00:00.000Z",
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
