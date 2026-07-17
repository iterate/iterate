#!/usr/bin/env bun
/** @jsxImportSource @opentui/react */
// oxlint-disable react/only-export-components -- CLI entrypoint, not a Vite Fast Refresh module.
/**
 * React/OpenTUI terminal chat with one project agent.
 *
 * The data layer is the SAME client stack the web app renders from: the
 * one-socket session keeper (`iterate/client`, pointed at the deployment via
 * `configureIterateSession`) and the shared React hooks (`iterate/react` —
 * `useItxSubscription` owns reconnect, watchdog, and re-subscribe recovery),
 * folding stream events through the shared agent-ui reducer
 * (@iterate-com/ui). Sends go through `agent.message` on the same socket.
 * This file owns only terminal runtime state and rendering — OpenTUI is just
 * another React renderer, so the hooks (TanStack Query included) run here
 * unchanged.
 */
import { StyledText, bg, fg } from "@opentui/core";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { useCallback, useState, useSyncExternalStore } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AgentUiActivity,
  AgentUiItem,
  AgentUiMessageItem,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import {
  configureIterateSession,
  connectItx,
  useItxSubscription,
  type Itx,
  type ItxSubscriptionStatus,
} from "../itx/itx-react.ts";
import { createAgentFeedModel, type AgentFeedSnapshot } from "./agent-feed-model.ts";
import { resolveItxAuth } from "./itx-auth.ts";
import {
  formatActivitySummary,
  formatLiveActivityLabel,
  formatStepLine,
  streamingTail,
} from "./feed-format.ts";
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("iterate chat requires an interactive terminal.");
}

const COLORS = {
  bg: "#0b0f14",
  surface: "#27272a",
  border: "#3f3f46",
  accent: "#22c55e",
  warning: "#facc15",
  danger: "#ef4444",
  text: "#e5e7eb",
  textSecondary: "#9ca3af",
  textBody: "#d1d5db",
  textMuted: "#6b7280",
  agent: "#a78bfa",
} as const;

// The onboarding agent is born server-side at project creation with its own
// system prompt; the TUI must never birth a prompt-less stand-in for it. The
// path is public contract (also the `iterate chat` default agent path).
const ONBOARDING_AGENT_PATH = "/agents/onboarding";

const args = parseArgs(process.argv.slice(2));

// One keeper socket for the whole process — the TUI's equivalent of the
// browser tab. Everything below (subscription, sends) rides it.
configureIterateSession({
  baseUrl: args.baseUrl,
  credentials: resolveItxAuth({ configName: process.env.ITERATE_CONFIG_NAME }),
});

// ---------------------------------------------------------------------------
// App state: one feed model, exposed to React through a tiny external store
// (the subscription's event batches arrive outside React).
// ---------------------------------------------------------------------------

const model = createAgentFeedModel();
let feedSnapshot: AgentFeedSnapshot = model.snapshot();
const feedListeners = new Set<() => void>();

function publishFeed() {
  feedSnapshot = model.snapshot();
  for (const listener of feedListeners) listener();
}

/**
 * Establish the live agent feed on the shared socket: ensure the agent exists
 * (explicit birth only for scratch agents — see ONBOARDING_AGENT_PATH), then
 * subscribe from the feed model's resume cursor. useItxSubscription re-runs
 * this on every recovery, so the cursor read is per-(re)subscribe and replay
 * overlap is folded out by the model's offset dedupe.
 */
async function subscribeAgentFeed(itx: Itx) {
  const snapshot = await itx.agents.get(args.agentPath).processor.snapshot();
  if (snapshot.state.birthCertificate === null) {
    if (args.agentPath === ONBOARDING_AGENT_PATH) {
      throw new Error(
        "this project's onboarding agent has not been born yet — open the project in the dashboard once, then retry",
      );
    }
    await itx.agents.get(args.agentPath).create({});
  }
  return await itx.agents.get(args.agentPath).stream.subscribe({
    processEventBatch: (batch) => {
      if (model.applyEvents(batch.events)) publishFeed();
    },
    replayAfterOffset: model.snapshot().lastOffset,
    subscriber: { description: "iterate chat TUI" },
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function AgentChatApp() {
  const feed = useSyncExternalStore(
    useCallback((listener: () => void) => {
      feedListeners.add(listener);
      return () => feedListeners.delete(listener);
    }, []),
    () => feedSnapshot,
  );
  const subscription = useItxSubscription(subscribeAgentFeed, [], { slug: args.projectId });
  const [notice, setNotice] = useState("");
  const [composerValue, setComposerValue] = useState("");
  const [composerRevision, setComposerRevision] = useState(0);

  const clearComposer = useCallback(() => {
    setComposerValue("");
    setComposerRevision((previous) => previous + 1);
  }, []);

  useKeyboard((key) => {
    if (key.name === "escape") clearComposer();
  });

  const submit = useCallback(
    (value: string) => {
      const message = value.trim();
      if (message === "") return;
      clearComposer();
      setNotice("sending…");
      connectItx(args.projectId)
        .then((itx) => itx.agents.get(args.agentPath).message(message))
        .then(() => setNotice(""))
        .catch((error: unknown) => {
          setNotice(`send failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    },
    [clearComposer],
  );

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={COLORS.bg}>
      <ChatHeader
        status={subscription.status}
        detail={subscription.error}
        notice={notice}
        eventCount={feed.eventCount}
      />
      <scrollbox
        width="100%"
        flexGrow={1}
        border
        borderStyle="single"
        borderColor={COLORS.border}
        backgroundColor={COLORS.bg}
        stickyScroll
        stickyStart="bottom"
        contentOptions={{ flexDirection: "column", paddingLeft: 1, paddingRight: 1, gap: 1 }}
      >
        {feed.items.length === 0 && feed.live == null ? (
          <text fg={COLORS.textMuted}>
            No messages yet — say something to {args.agentPath.slice("/agents/".length)}.
          </text>
        ) : null}
        {feed.items.map((item) => (
          <FeedItem key={item.id} item={item} />
        ))}
        {feed.live == null ? null : <LiveActivity activity={feed.live} />}
      </scrollbox>
      <box
        width="100%"
        height={3}
        border
        borderStyle="single"
        borderColor={COLORS.accent}
        backgroundColor={COLORS.bg}
        paddingLeft={1}
        paddingRight={1}
      >
        <input
          key={composerRevision}
          width="100%"
          value={composerValue}
          placeholder="Message the agent (Enter to send, Ctrl+C to quit)"
          focused
          backgroundColor="transparent"
          focusedBackgroundColor="transparent"
          textColor={COLORS.text}
          focusedTextColor={COLORS.text}
          placeholderColor={COLORS.textMuted}
          cursorColor={COLORS.accent}
          onInput={setComposerValue}
          onSubmit={(value) => {
            if (typeof value === "string") submit(value);
          }}
        />
      </box>
    </box>
  );
}

function ChatHeader(props: {
  status: ItxSubscriptionStatus;
  detail: string | undefined;
  notice: string;
  eventCount: number;
}) {
  const statusLabel =
    props.status === "live"
      ? "live"
      : props.status === "connecting"
        ? "connecting"
        : `error (${props.detail ?? "unknown"})`;
  const statusColor =
    props.status === "live"
      ? COLORS.accent
      : props.status === "connecting"
        ? COLORS.warning
        : COLORS.danger;
  const meta = [
    `${props.eventCount} event${props.eventCount === 1 ? "" : "s"}`,
    statusLabel,
    props.notice,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <box
      width="100%"
      height={3}
      border
      borderStyle="single"
      borderColor={COLORS.border}
      backgroundColor={COLORS.surface}
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      gap={1}
    >
      <text width={6} content={getBrandMarkText()} />
      <text flexGrow={1} fg={COLORS.text} content={`${args.projectId} ${args.agentPath}`} />
      <text fg={COLORS.textSecondary} content={meta} />
      <text width={2} fg={statusColor}>
        ●
      </text>
    </box>
  );
}

function FeedItem(props: { item: AgentUiItem }) {
  const item = props.item;
  if (item.kind === "activity") return <SettledActivity activity={item} />;
  if (item.kind === "user" || item.kind === "assistant") return <Message item={item} />;
  if (item.kind === "child-stream-created") {
    return <text fg={COLORS.textMuted}>✦ child stream created: {item.childPath}</text>;
  }
  return <text fg={COLORS.textMuted}>✦ {item.text}</text>;
}

function Message(props: { item: AgentUiMessageItem }) {
  const isUser = props.item.kind === "user";
  return (
    <box flexDirection="column">
      <text fg={isUser ? COLORS.accent : COLORS.agent}>
        {isUser ? "you ›" : "agent ›"}
        <span fg={COLORS.textMuted}> {formatClock(props.item.timestampMs)}</span>
      </text>
      <text fg={COLORS.textBody}>{props.item.text}</text>
    </box>
  );
}

function SettledActivity(props: { activity: AgentUiActivity }) {
  return (
    <box flexDirection="column">
      <text fg={COLORS.textMuted}>✦ {formatActivitySummary(props.activity)}</text>
      {props.activity.steps.map((step) => (
        <text key={step.id} fg={COLORS.textMuted}>
          {"  "}· {formatStepLine(step)}
        </text>
      ))}
    </box>
  );
}

/** Shared 100ms clock for live "Running code 0.9s" — useSyncExternalStore,
 * not useState+setInterval, so the snapshot is stable between ticks. */
let liveCodeClockNow = Date.now();
const liveCodeClockListeners = new Set<() => void>();
let liveCodeClockTimer: ReturnType<typeof setInterval> | undefined;

function subscribeLiveCodeClock(onStoreChange: () => void) {
  liveCodeClockListeners.add(onStoreChange);
  liveCodeClockNow = Date.now();
  if (liveCodeClockTimer == null) {
    liveCodeClockTimer = setInterval(() => {
      liveCodeClockNow = Date.now();
      for (const listener of liveCodeClockListeners) listener();
    }, 100);
  }
  // Notify after subscribe returns so the first snapshot is current wall time
  // (updating the scalar alone does not re-render useSyncExternalStore).
  // Skip if already unsubscribed (Strict Mode remount / codeRunning flip).
  queueMicrotask(() => {
    if (liveCodeClockListeners.has(onStoreChange)) onStoreChange();
  });
  return () => {
    liveCodeClockListeners.delete(onStoreChange);
    if (liveCodeClockListeners.size === 0 && liveCodeClockTimer != null) {
      clearInterval(liveCodeClockTimer);
      liveCodeClockTimer = undefined;
    }
  };
}

function getLiveCodeClockSnapshot() {
  // Idle: refresh only when a full tick has elapsed so remounts aren't stuck
  // on a stale freeze, but consecutive getSnapshot calls stay Object.is-stable.
  if (liveCodeClockTimer == null) {
    const wall = Date.now();
    if (wall - liveCodeClockNow >= 100) liveCodeClockNow = wall;
  }
  return liveCodeClockNow;
}

function LiveActivity(props: { activity: AgentUiActivity }) {
  // Tick while code runs so "Running code 0.9s" counts up without waiting
  // for feed events (script execution often emits nothing mid-run).
  const codeRunning =
    props.activity.steps.some((step) => step.kind === "code" && step.status === "running") ||
    props.activity.phase === "script";
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!codeRunning) return () => {};
      return subscribeLiveCodeClock(onStoreChange);
    },
    [codeRunning],
  );
  const nowMs = useSyncExternalStore(subscribe, getLiveCodeClockSnapshot, getLiveCodeClockSnapshot);

  const lastStep = props.activity.steps.findLast((step) => step.status === "running");
  const thinking = lastStep?.kind === "llm" ? streamingTail(lastStep.thinkingText) : "";
  const streamed =
    lastStep?.kind === "llm"
      ? streamingTail(lastStep.responseText)
      : lastStep?.kind === "code"
        ? streamingTail(lastStep.code)
        : "";
  return (
    <box flexDirection="column">
      <text fg={COLORS.warning}>✦ {formatLiveActivityLabel(props.activity, nowMs)}</text>
      {props.activity.steps.map((step) => (
        <text key={step.id} fg={COLORS.textMuted}>
          {"  "}· {formatStepLine(step)}
        </text>
      ))}
      {thinking === "" ? null : <text fg={COLORS.textMuted}>{thinking}</text>}
      {streamed === "" ? null : <text fg={COLORS.textSecondary}>{streamed}</text>}
    </box>
  );
}

function getBrandMarkText() {
  return new StyledText([
    fg("#000000")(bg(COLORS.surface)("▐")),
    bg("#000000")(fg("#ffffff")(" 𝑖 ")),
    fg("#000000")(bg(COLORS.surface)("▌")),
  ]);
}

function formatClock(timestampMs: number) {
  return new Date(timestampMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseArgs(argv: string[]) {
  const baseUrl = readFlag(argv, "--base-url");
  const projectId = readFlag(argv, "--project-id");
  const agentPath = readFlag(argv, "--agent-path");

  if (baseUrl == null || projectId == null || agentPath == null) {
    throw new Error(
      "Usage: bun agent-chat-terminal.tsx --base-url <url> --project-id <prj_id> --agent-path </agents/name>",
    );
  }
  if (!agentPath.startsWith("/agents/")) {
    throw new Error(`--agent-path must start with "/agents/", got "${agentPath}".`);
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    projectId,
    agentPath,
  };
}

function readFlag(argv: string[], flagName: string) {
  const index = argv.indexOf(flagName);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value == null || value.startsWith("--")) {
    throw new Error(`${flagName} requires a value.`);
  }
  return value;
}

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  targetFps: 30,
  screenMode: "alternate-screen",
  consoleMode: "disabled",
});
// TanStack Query rides OpenTUI like any other React renderer; the provider is
// here so feature code can use the shared query hooks, not just subscriptions.
const queryClient = new QueryClient();
createRoot(renderer).render(
  <QueryClientProvider client={queryClient}>
    <AgentChatApp />
  </QueryClientProvider>,
);
