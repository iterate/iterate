#!/usr/bin/env bun
/** @jsxImportSource @opentui/react */
// oxlint-disable react/only-export-components -- CLI entrypoint, not a Vite Fast Refresh module.
/**
 * React/OpenTUI terminal chat with one project agent.
 *
 * The data layer is the shared client stack, not a bespoke stream client:
 * `connectItx` (apps/os/src/next/client.ts) hands us the same `Agent`
 * capability the web app uses, a live `stream.subscribe` pumps events into
 * the shared agent-ui reducer (@iterate-com/ui), and sends go through
 * `agent.sendMessage`. This file owns only terminal runtime state and
 * rendering.
 */
import { StyledText, bg, fg } from "@opentui/core";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { useCallback, useState, useSyncExternalStore } from "react";
import type {
  AgentUiActivity,
  AgentUiItem,
  AgentUiMessageItem,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { createAgentFeedModel, type AgentFeedSnapshot } from "./agent-feed-model.ts";
import {
  connectAgentFeed,
  resolveItxAuth,
  type AgentConnectionStatus,
} from "./agent-connection.ts";
import { formatActivitySummary, formatStepLine, streamingTail } from "./feed-format.ts";

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

const args = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// App state: one feed model + one connection, exposed to React through a tiny
// external store (the connection callbacks fire outside React).
// ---------------------------------------------------------------------------

type AppState = {
  feed: AgentFeedSnapshot;
  status: AgentConnectionStatus;
  notice: string;
};

const model = createAgentFeedModel();
let appState: AppState = {
  feed: model.snapshot(),
  status: { kind: "connecting" },
  notice: "",
};
const listeners = new Set<() => void>();

function patchAppState(patch: Partial<AppState>) {
  appState = { ...appState, ...patch };
  for (const listener of listeners) listener();
}

const connection = connectAgentFeed({
  auth: resolveItxAuth({ configName: process.env.ITERATE_CONFIG_NAME }),
  baseUrl: args.baseUrl,
  projectId: args.projectId,
  agentPath: args.agentPath,
  replayAfterOffset: () => model.snapshot().lastOffset,
  onEvents: (events) => {
    if (model.applyEvents(events)) patchAppState({ feed: model.snapshot() });
  },
  onStatus: (status) => patchAppState({ status }),
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function AgentChatApp() {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }, []),
    () => appState,
  );
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
      patchAppState({ notice: "sending…" });
      connection
        .sendMessage(message)
        .then(() => patchAppState({ notice: "" }))
        .catch((error: unknown) => {
          patchAppState({
            notice: `send failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
    },
    [clearComposer],
  );

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={COLORS.bg}>
      <ChatHeader status={state.status} notice={state.notice} eventCount={state.feed.eventCount} />
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
        {state.feed.items.length === 0 && state.feed.live == null ? (
          <text fg={COLORS.textMuted}>
            No messages yet — say something to {args.agentPath.slice("/agents/".length)}.
          </text>
        ) : null}
        {state.feed.items.map((item) => (
          <FeedItem key={item.id} item={item} />
        ))}
        {state.feed.live == null ? null : <LiveActivity activity={state.feed.live} />}
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

function ChatHeader(props: { status: AgentConnectionStatus; notice: string; eventCount: number }) {
  const statusLabel =
    props.status.kind === "live"
      ? "live"
      : props.status.kind === "connecting"
        ? "connecting"
        : `reconnecting (${props.status.detail})`;
  const statusColor =
    props.status.kind === "live"
      ? COLORS.accent
      : props.status.kind === "connecting"
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
  if (props.item.kind === "activity") return <SettledActivity activity={props.item} />;
  return <Message item={props.item} />;
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

function LiveActivity(props: { activity: AgentUiActivity }) {
  const lastStep = props.activity.steps[props.activity.steps.length - 1];
  const thinking = lastStep?.kind === "llm" ? streamingTail(lastStep.thinkingText) : "";
  const streamed =
    lastStep?.kind === "llm"
      ? streamingTail(lastStep.responseText)
      : lastStep?.kind === "code"
        ? streamingTail(lastStep.code)
        : "";
  return (
    <box flexDirection="column">
      <text fg={props.activity.status === "waiting" ? COLORS.textMuted : COLORS.warning}>
        ✦ {props.activity.status === "waiting" ? "waiting" : "working…"}
      </text>
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
process.on("exit", () => connection.dispose());
createRoot(renderer).render(<AgentChatApp />);
