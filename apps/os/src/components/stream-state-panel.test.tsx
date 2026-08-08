// @vitest-environment jsdom

import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  AgentUiPresenceEntry,
  AgentUiProcessorAnnouncement,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { TooltipProvider } from "@iterate-com/ui/components/tooltip";
import type { StreamRuntimeDebugState } from "../domains/streams/stream-runtime-state.ts";
import { CoreProcessorContract } from "../domains/streams/core-processor-contract.ts";

const liveStateMocks = vi.hoisted(() => ({
  project: vi.fn(),
  session: vi.fn(),
}));

vi.mock("iterate/sdk/itx/react", () => ({
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

import { PresenceAvatar, StreamStatePanel } from "./stream-state-panel.tsx";
import { CorePrettyState } from "./stream-processor-pretty-state.tsx";

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

test("presence avatars render an authenticated user's picture with an initials fallback", async () => {
  const { host, root } = mountPanel();
  const entry: AgentUiPresenceEntry = {
    connectionKey: "browser:tab-1",
    connectionKind: "session",
    connected: true,
    description: "browser",
    user: {
      id: "usr_jonas",
      email: "jonas@example.com",
      name: "Jonas Temple",
      picture: "https://example.com/jonas.png",
    },
  };

  await act(async () => root.render(<PresenceAvatar entry={entry} busy={false} />));

  expect(host.querySelector("[data-slot=avatar-image]")?.getAttribute("src")).toBe(
    entry.user?.picture,
  );
  expect(host.querySelector("[data-slot=avatar-fallback]")?.textContent).toBe("JT");
});

test("presence tooltips show human identity and processor names", async () => {
  const human: AgentUiPresenceEntry = {
    connectionKey: "browser:tab-1",
    connectionKind: "session",
    connected: true,
    user: {
      id: "usr_jonas",
      email: "jonas@example.com",
      name: "Jonas Temple",
    },
  };
  const { host, root } = mountPanel();
  const render = (entry: AgentUiPresenceEntry) =>
    root.render(
      <TooltipProvider delay={0}>
        <PresenceAvatar entry={entry} busy={false} />
      </TooltipProvider>,
    );

  await act(async () => render(human));
  await hoverPresenceAvatar(host);
  expect(document.body.querySelector("[data-slot=tooltip-content]")?.textContent).toBe(
    "NameJonas TempleEmail addressjonas@example.comUser IDusr_jonas",
  );

  await act(async () => render(processorPresence));
  await hoverPresenceAvatar(host);
  expect(document.body.querySelector("[data-slot=tooltip-content]")?.textContent).toBe(
    "test processor",
  );
});

test("a focused human session connection shows their name, email address, and user id", async () => {
  liveStateMocks.project.mockReturnValue({
    value: undefined,
    status: "connecting",
    error: undefined,
    refresh: vi.fn(),
  });
  liveStateMocks.session.mockReturnValue({
    value: undefined,
    status: "connecting",
    error: undefined,
    refresh: vi.fn(),
  });
  const entry: AgentUiPresenceEntry = {
    connectionKey: "browser:tab-1",
    connectionKind: "session",
    connected: true,
    description: "browser",
    user: {
      id: "usr_jonas",
      email: "jonas@example.com",
      name: "Jonas Temple",
    },
    processor: {
      ...processorAnnouncement,
      slug: "browser-feed",
      description: "Mirrors a stream in the browser.",
    },
  };
  const { host, root } = mountPanel();

  await act(async () =>
    root.render(
      <StreamStatePanel
        {...panelProps({
          focusedKey: entry.connectionKey,
          presence: [entry],
        })}
      />,
    ),
  );

  const userDetails = host.querySelector("dl");
  expect(userDetails?.textContent).toContain("NameJonas Temple");
  expect(userDetails?.textContent).toContain("Email addressjonas@example.com");
  expect(userDetails?.textContent).toContain("User IDusr_jonas");
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
          focusedKey: PROCESSOR_SUBSCRIPTION_NAME,
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
  expect(getProcessorRuntimeState).toHaveBeenCalledWith(PROCESSOR_SUBSCRIPTION_NAME);

  projectRuntime.value = streamRuntimeState(6);
  await act(async () => render());

  expect(getProcessorRuntimeState).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain("Loading reduced state");
  expect(host.querySelector("[data-testid=serialized-state]")?.textContent).toBe('{"stable":true}');
});

test("stream vitals expose the memory-only ephemeral buffer and FIFO evictions", async () => {
  const runtime = streamRuntimeState(8);
  runtime.runtime.ephemeralEvents = {
    maxBytes: 10 * 1024 * 1024,
    bytes: 1_536,
    eventCount: 3,
    oldestOffset: 4,
    newestOffset: 8,
    evictedEventCount: 2,
    evictedBytes: 512,
  };
  liveStateMocks.project.mockReturnValue({
    value: runtime,
    status: "live" as const,
    error: undefined,
    refresh: vi.fn(),
  });
  liveStateMocks.session.mockReturnValue({
    value: undefined,
    status: "connecting",
    error: undefined,
    refresh: vi.fn(),
  });
  const { host, root } = mountPanel();

  await act(async () => root.render(<StreamStatePanel {...panelProps()} />));

  expect(host.textContent).toContain("ephemeral memory3 · 1.5 KB");
  expect(host.textContent).toContain("ephemeral evicted2 · 512 B");
});

test.each([
  ["beginning", "beginning (all history)"],
  ["now", "now (from configure time)"],
] as const)("a durable receiver renders the stored %j start position", async (start, label) => {
  const name = "copy-from-offset";
  const state = streamRuntimeState(8);
  state.coreProcessorState = CoreProcessorContract.stateSchema.parse({
    maxOffset: 8,
    subscriptions: {
      outbound: {
        byName: {
          [name]: {
            configuredAtOffset: 7,
            configuredAt: "2026-07-21T12:00:00.000Z",
            configuration: {
              name,
              receiver: {
                action: "copy-to-stream",
                receivingStreamPath: "/receiver",
                delivery: {
                  start,
                  onFailingEvent: "halt",
                },
              },
            },
          },
        },
      },
    },
  });
  state.runtime.subscriptions[name] = {
    confirmedOffset: 4,
    lag: 4,
    status: "active",
    attempt: 0,
    nextAttemptAt: null,
    inFlightDeadlineAt: null,
    lastError: null,
  };
  liveStateMocks.project.mockReturnValue({
    value: state,
    status: "live" as const,
    error: undefined,
    refresh: vi.fn(),
  });
  liveStateMocks.session.mockReturnValue({
    value: undefined,
    status: "connecting",
    error: undefined,
    refresh: vi.fn(),
  });

  const { host, root } = mountPanel();
  await act(async () => {
    root.render(<StreamStatePanel {...panelProps({ focusedKey: name })} />);
  });

  await vi.waitFor(() => expect(host.textContent).toContain(label));
});

test("the catalog renders one uniform row per subscription with status and lag", async () => {
  const state = streamRuntimeState(20);
  state.coreProcessorState = CoreProcessorContract.stateSchema.parse({
    maxOffset: 20,
    subscriptions: {
      outbound: {
        byName: {
          "live-capability": {
            configuredAtOffset: 2,
            configuredAt: "2026-07-21T12:00:00.000Z",
            configuration: {
              name: "live-capability",
              receiver: {
                action: "itx-call",
                expression: ["capabilities", "processEventBatch"],
                delivery: { start: "now", onFailingEvent: "halt" },
              },
            },
          },
          "ops-webhook": {
            configuredAtOffset: 3,
            configuredAt: "2026-07-21T12:00:00.000Z",
            configuration: {
              name: "ops-webhook",
              receiver: {
                action: "webhook-post",
                url: "https://hooks.example.com/events",
                delivery: { start: "now", onFailingEvent: "skip" },
              },
            },
            deliveryHalted: {
              reason: "delivery-failed",
              afterOffset: 9,
              attempts: 15,
              error: "HTTP 500 from receiver",
            },
          },
        },
      },
    },
  });
  state.runtime.subscriptions["live-capability"] = {
    confirmedOffset: 12,
    lag: 8,
    status: "active",
    attempt: 3,
    nextAttemptAt: 1_753_000_000_000,
    inFlightDeadlineAt: null,
    lastError: 'capability "dashboard" is offline',
  };
  state.runtime.subscriptions["ops-webhook"] = {
    confirmedOffset: 9,
    lag: 11,
    status: "halted",
    attempt: 15,
    nextAttemptAt: null,
    inFlightDeadlineAt: null,
    lastError: "HTTP 500 from receiver",
  };
  liveStateMocks.project.mockReturnValue({
    value: state,
    status: "live" as const,
    error: undefined,
    refresh: vi.fn(),
  });
  liveStateMocks.session.mockReturnValue({
    value: undefined,
    status: "connecting",
    error: undefined,
    refresh: vi.fn(),
  });

  const { host, root } = mountPanel();
  await act(async () => {
    root.render(<StreamStatePanel {...panelProps()} />);
  });

  const backoffRow = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("live-capability"),
  );
  expect(backoffRow?.textContent).toContain("backoff");
  expect(backoffRow?.textContent).toContain("itx-call");
  // lag = head − confirmed (8).
  expect(backoffRow?.textContent).toContain("8");
  expect(backoffRow?.textContent).toContain('capability "dashboard" is offline');

  const haltedRow = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("ops-webhook"),
  );
  expect(haltedRow?.textContent).toContain("halted after #9 (15 attempts)");
  expect(haltedRow?.textContent).toContain("HTTP 500 from receiver");

  // The wake feed serving the processor subscription lists under connections.
  expect(host.textContent).toContain(`wake feed · ${PROCESSOR_SUBSCRIPTION_NAME}`);
});

test("core state renders the passive inbound record for each source subscription", async () => {
  const { host, root } = mountPanel();
  await act(async () => {
    root.render(
      <CorePrettyState
        runtime={undefined}
        state={{
          maxOffset: 12,
          eventCount: 12,
          subscriptions: {
            inbound: {
              bySourcePath: {
                "/source": {
                  "copy-to-receiver": {
                    streamId: "11111111-1111-4111-8111-111111111111",
                    streamCreatedAt: "2026-07-21T11:00:00.000Z",
                    cursorChangedAtSourceOffset: 7,
                    numEventsReceived: 3,
                    lastEventReceivedAt: "2026-07-21T12:00:00.000Z",
                  },
                },
              },
            },
          },
        }}
      />,
    );
  });

  expect(host.textContent).toContain("/source");
  expect(host.textContent).toContain("copy-to-receiver");
  expect(host.textContent).toContain("3 received");
  expect(host.textContent).toContain("last event 2026-07-21T12:00:00.000Z");
});

test("core state marks halted outbound subscriptions distinctly", async () => {
  const { host, root } = mountPanel();
  await act(async () => {
    root.render(
      <CorePrettyState
        runtime={undefined}
        state={{
          maxOffset: 12,
          eventCount: 12,
          subscriptions: {
            outbound: {
              byName: {
                "live-capability": {
                  configuredAtOffset: 2,
                  configuredAt: "2026-07-21T12:00:00.000Z",
                  configuration: {
                    name: "live-capability",
                    receiver: {
                      action: "itx-call",
                      expression: ["capabilities", "processEventBatch"],
                      delivery: { start: "now", onFailingEvent: "halt" },
                    },
                  },
                  deliveryHalted: {
                    reason: "delivery-failed",
                    afterOffset: 8,
                    attempts: 15,
                  },
                },
              },
            },
          },
        }}
      />,
    );
  });

  expect(host.textContent).toContain("live-capability");
  expect(host.textContent).toContain("itx-call · halted");
});

function mountPanel() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  return { host, root };
}

async function hoverPresenceAvatar(host: HTMLElement): Promise<void> {
  const trigger = host.querySelector("[data-slot=tooltip-trigger]");
  if (!(trigger instanceof HTMLElement)) throw new Error("presence tooltip trigger missing");
  await act(async () => {
    const pointerOver = new MouseEvent("pointerover", { bubbles: true });
    Object.defineProperty(pointerOver, "pointerType", { value: "mouse" });
    trigger.dispatchEvent(pointerOver);
    trigger.dispatchEvent(new MouseEvent("mouseenter"));
  });
  await vi.waitFor(() => {
    expect(document.body.querySelector("[data-slot=tooltip-content]")).not.toBeNull();
  });
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

/** One name, four systems: catalog key, wake-feed connection key, itx segment, progress key. */
const PROCESSOR_SUBSCRIPTION_NAME = "test";

const processorPresence: AgentUiPresenceEntry = {
  connectionKey: PROCESSOR_SUBSCRIPTION_NAME,
  connectionKind: "hosted",
  connected: true,
  processor: processorAnnouncement,
};

const emptyMetrics = {
  spark: [],
  transportRttMs: null,
  eventConsumption: undefined,
};

/**
 * A stream with one processor-wake subscription named `test` whose wake feed
 * is open (the hosted connection carries the subscription name).
 */
function streamRuntimeState(maxOffset: number): StreamRuntimeDebugState {
  return {
    coreProcessorState: CoreProcessorContract.stateSchema.parse({
      maxOffset,
      subscriptions: {
        outbound: {
          byName: {
            [PROCESSOR_SUBSCRIPTION_NAME]: {
              configuredAtOffset: 1,
              configuredAt: "2026-07-18T00:00:00.000Z",
              configuration: {
                name: PROCESSOR_SUBSCRIPTION_NAME,
                receiver: {
                  action: "wake-processor",
                  expression: ["agents", "processor", "wakeStreamProcessor"],
                },
              },
            },
          },
        },
      },
    }),
    runtime: {
      connections: {
        [PROCESSOR_SUBSCRIPTION_NAME]: {
          kind: "hosted",
          name: PROCESSOR_SUBSCRIPTION_NAME,
          startedAt: "2026-07-18T00:00:00.000Z",
          deliveredThroughOffset: maxOffset,
          lag: 0,
          batchesSent: 1,
          eventsSent: 1,
          bytesSent: 1,
          openedBy: { processor: { announcement: processorAnnouncement } },
          hasPendingDelivery: false,
        },
      },
      dormantSubscribers: {},
      subscriptions: {
        [PROCESSOR_SUBSCRIPTION_NAME]: {
          confirmedOffset: maxOffset,
          lag: 0,
          status: "active",
          attempt: 0,
          nextAttemptAt: null,
          inFlightDeadlineAt: null,
          lastError: null,
        },
      },
      ephemeralEvents: {
        maxBytes: 10 * 1024 * 1024,
        bytes: 0,
        eventCount: 0,
        evictedEventCount: 0,
        evictedBytes: 0,
      },
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
