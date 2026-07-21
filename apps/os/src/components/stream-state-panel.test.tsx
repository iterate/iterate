// @vitest-environment jsdom

import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  AgentUiPresenceEntry,
  AgentUiProcessorAnnouncement,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { TooltipProvider } from "@iterate-com/ui/components/tooltip";
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

import { PresenceAvatar, StreamStatePanel } from "./stream-state-panel.tsx";

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
    subscriptionKey: "browser:tab-1",
    direction: "inbound",
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
    subscriptionKey: "browser:tab-1",
    direction: "inbound",
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

test("a focused human subscriber shows their name, email address, and user id", async () => {
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
    subscriptionKey: "browser:tab-1",
    direction: "inbound",
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
          focusedKey: entry.subscriptionKey,
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
