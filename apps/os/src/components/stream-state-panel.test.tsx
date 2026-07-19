// @vitest-environment jsdom

import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  AgentUiPresenceEntry,
  AgentUiProcessorAnnouncement,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import type { StreamRuntimeDebugState } from "../itx-api.generated.ts";

const liveStateMocks = vi.hoisted(() => ({
  project: vi.fn(),
  session: vi.fn(),
}));

vi.mock("iterate/react", () => ({
  useLiveState: liveStateMocks.project,
  useIterateSessionLiveState: liveStateMocks.session,
}));

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

import { StreamStatePanel } from "./stream-state-panel.tsx";

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
  const projectRuntime = {
    value: streamRuntimeState(5),
    status: "live" as const,
    error: undefined,
    refresh: vi.fn(),
  };
  liveStateMocks.project.mockReturnValue(projectRuntime);
  liveStateMocks.session.mockReturnValue({
    value: undefined,
    status: "connecting",
    error: undefined,
    refresh: vi.fn(),
  });
  const getProcessorRuntimeState = vi.fn().mockResolvedValue({
    snapshot: { offset: 5, state: { stable: true } },
    runtime: null,
  });
  const { host, root } = mountPanel();
  const render = () =>
    root.render(
      <StreamStatePanel
        {...panelProps({
          focusedKey: processorPresence.subscriptionKey,
          getProcessorRuntimeState,
          presence: [processorPresence],
        })}
      />,
    );

  await act(async () => render());
  await vi.waitFor(() => {
    expect(host.querySelector("[data-testid=serialized-state]")?.textContent).toBe(
      '{"stable":true}',
    );
  });
  expect(getProcessorRuntimeState).toHaveBeenCalledTimes(1);

  projectRuntime.value = streamRuntimeState(6);
  await act(async () => render());

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
    projectId: "prj_test",
    streamPath: "/test",
    ...overrides,
  };
}

const processorAnnouncement: AgentUiProcessorAnnouncement = {
  slug: "test",
  version: "1.0.0",
  description: "Test processor",
  consumes: [],
  emits: [],
  ownedEvents: [],
};

const processorPresence: AgentUiPresenceEntry = {
  subscriptionKey: "processor:test",
  direction: "outbound",
  connected: true,
  processor: processorAnnouncement,
};

const emptyMetrics = {
  spark: [],
  transportRttMs: null,
  subscriber: undefined,
};

function streamRuntimeState(maxOffset: number): StreamRuntimeDebugState {
  return {
    coreProcessorState: { maxOffset },
    runtime: {
      connections: {
        [processorPresence.subscriptionKey]: {
          subscriptionType: "ephemeral",
          startedAt: "2026-07-18T00:00:00.000Z",
          cursor: maxOffset,
          lag: 0,
          batchesSent: 1,
          eventsSent: 1,
          bytesSent: 1,
          subscriber: { processor: { announcement: processorAnnouncement } },
          hasPendingDelivery: false,
        },
      },
      subscriptions: {},
      metrics: {
        measuredSince: "2026-07-18T00:00:00.000Z",
        reportedAt: "2026-07-18T00:00:00.000Z",
        ingress: {
          bytesPerSecond5s: 0,
          perSecond5s: 0,
          lastMinute: { count: 0, bytes: 0, perSecond: 0 },
          series: { counts: [], bytes: [] },
        },
        egress: {
          bytesPerSecond5s: 0,
          perSecond5s: 0,
          lastMinute: { count: 0, bytes: 0, perSecond: 0 },
          series: { counts: [], bytes: [] },
        },
      },
      storageSizeBytes: 0,
    },
  };
}
