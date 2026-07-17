/** @jsxImportSource @opentui/react */
/**
 * Presentational components for the agent chat TUI: the header, feed items,
 * and the live-activity block with its ticking code clock. Pure rendering over
 * the feed model's snapshots — no connection state, no side effects beyond the
 * shared clock store.
 */
import { StyledText, bg, fg } from "@opentui/core";
import { useCallback, useSyncExternalStore } from "react";
import type {
  AgentUiActivity,
  AgentUiItem,
  AgentUiMessageItem,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import type { ItxSubscriptionStatus } from "../itx/itx-react.ts";
import { COLORS } from "./chat-colors.ts";
import {
  formatActivitySummary,
  formatLiveActivityLabel,
  formatStepLine,
  streamingTail,
} from "./feed-format.ts";

export function ChatHeader(props: {
  title: string;
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
      <text flexGrow={1} fg={COLORS.text} content={props.title} />
      <text fg={COLORS.textSecondary} content={meta} />
      <text width={2} fg={statusColor}>
        ●
      </text>
    </box>
  );
}

export function FeedItem(props: { item: AgentUiItem }) {
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

export function LiveActivity(props: { activity: AgentUiActivity }) {
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
