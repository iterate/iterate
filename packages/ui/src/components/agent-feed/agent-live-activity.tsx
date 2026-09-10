import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { deriveAgentDisplayState, type AgentRuntime } from "@iterate-com/shared/agent-events";
import { BanIcon, ChevronRightIcon, CircleAlertIcon, CodeIcon } from "lucide-react";
import {
  formatAgentUiActivitySummary,
  groupActivityRounds,
  isAgentUiActivityWorking,
  summarizeAgentUiActivity,
  type AgentUiActivity,
  type AgentUiCodeStep,
  type AgentUiLlmStep,
  type AgentUiMessageItem,
  type AgentUiStep,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { Button } from "@iterate-com/ui/components/button";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { cn } from "@iterate-com/ui/lib/utils";
import {
  formatElapsedSeconds,
  liveActivityLabel,
  looksLikeCode,
} from "@iterate-com/ui/components/events/feed-format";
import { useTickingNowMs } from "@iterate-com/ui/hooks/use-ticking-now-ms";
import { AgentActivityRoundRow } from "./agent-activity-rounds.tsx";
import { AgentActivityRow, UserMessageBody } from "./agent-feed-item.tsx";

// The live end of the agent chat: the in-flight activity tail the feed's
// virtual list renders as its trailing item, and the queued-messages stack
// the composer wears. Settled rows live in agent-feed-item.tsx.

/**
 * Messages queued for after the running turn, rendered as PART OF THE
 * COMPOSER: the queue is input that hasn't reached the agent yet, so it
 * belongs with the input surface, not in the feed's history. The stack is a
 * rounded card tucked behind the composer pill (the pill overlaps its bottom
 * edge). On phones it collapses to the newest message — each new queued
 * message pushes the previous one out of view — with a "+N more" toggle;
 * wider viewports show the whole (scroll-capped) stack.
 */
export function QueuedMessagesPanel({
  messages,
  isInterrupting,
  onInterrupt,
}: {
  messages: AgentUiMessageItem[];
  isInterrupting: boolean;
  onInterrupt?: () => Promise<void> | void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (messages.length === 0) return null;
  const hiddenCount = messages.length - 1;
  return (
    <div
      className="-mb-4 rounded-t-3xl border border-b-0 bg-muted/40 px-3 pb-6 pt-1.5"
      data-testid="queued-messages-panel"
    >
      <div className="flex items-center gap-2 px-1.5 py-1">
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          Queued for the next agent turn
        </span>
        {hiddenCount > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="shrink-0 font-mono text-[11px] text-muted-foreground underline-offset-2 hover:underline sm:hidden"
          >
            {expanded ? "collapse" : `+${hiddenCount} more`}
          </button>
        ) : null}
        {onInterrupt == null ? null : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onInterrupt()}
            disabled={isInterrupting}
            className="ml-auto h-6 shrink-0 gap-1 px-2 text-[11px] text-red-700 hover:bg-red-50 hover:text-red-800 dark:text-red-300 dark:hover:bg-red-950/30"
          >
            {isInterrupting ? (
              <Spinner className="size-3" />
            ) : (
              <BanIcon className="size-3 text-current" />
            )}
            Interrupt & send now
          </Button>
        )}
      </div>
      <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
        {messages.map((message, index) => (
          <div
            key={message.id}
            className={cn(
              "rounded-xl border bg-background/80 px-3 py-1.5 text-sm",
              // The mobile push-out: only the newest message stays pinned to
              // the composer while collapsed.
              !expanded && index < messages.length - 1 && "hidden sm:block",
            )}
          >
            <UserMessageBody item={message} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The live element: accumulated activity followed by the current timed phase.
// ---------------------------------------------------------------------------

/**
 * The virtual list's trailing item whenever work is in flight. Receives the
 * live reduced state on every chunk: finished steps collapse upward into quiet
 * rows while current requests or scripts keep the busy indicator visible.
 */
export function AgentLiveActivity({
  live,
  runtime,
  toggledIds,
  onToggle,
  onInspectLlmRequest,
  onInspectScriptExecution,
  roundResult,
  roundMeta,
}: {
  live: AgentUiActivity;
  runtime: AgentRuntime;
  toggledIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onInspectLlmRequest?: (llmRequestOffset: number) => void;
  onInspectScriptExecution?: (executionId: string) => void;
  /** A round's Result tab body when the app can show the agent's own view of the settlement; see AgentActivityRounds. */
  roundResult?: (code: AgentUiCodeStep) => ReactNode;
  /** A round's Meta tab body when the app can replay its exact prompt; see AgentActivityRounds. */
  roundMeta?: (llm: AgentUiLlmStep, code: AgentUiCodeStep) => ReactNode;
}) {
  const runningSteps = live.steps.filter((step) => step.status === "running");
  const liveStep = runningSteps.at(-1);
  const doneSteps = live.steps.filter((step) => step.status === "done");
  const doneSummary = summarizeAgentUiActivity(live, doneSteps);
  const working = isAgentUiActivityWorking(live, runtime);
  const activityToggleId = `live-activity:${live.id}`;
  const activityExpanded = toggledIds.has(activityToggleId);
  const toggleActivity = useCallback(
    () => onToggle(activityToggleId),
    [activityToggleId, onToggle],
  );
  const showStepRail =
    activityExpanded &&
    (doneSteps.length > 0 ||
      runningSteps.some((step) => step.kind === "code" || liveStepHasVisibleContent(step)));

  const runtimeDisplayState = deriveAgentDisplayState(runtime);
  const runtimeWorkKind =
    runtimeDisplayState === "running_code"
      ? "code"
      : runtimeDisplayState === "waiting_for_model"
        ? "llm"
        : runtimeDisplayState === "queued"
          ? "queued"
          : null;
  const currentWorkKind = runtimeWorkKind ?? liveStep?.kind ?? null;
  const currentStep =
    currentWorkKind === "code" || currentWorkKind === "llm"
      ? runningSteps.findLast((step) => step.kind === currentWorkKind)
      : liveStep;
  const currentLabel =
    currentWorkKind === "code"
      ? "Running code"
      : currentWorkKind === "llm"
        ? currentStep?.kind === "llm"
          ? liveActivityLabel([currentStep])
          : "Waiting for a response"
        : currentWorkKind === "queued"
          ? "Queued"
          : liveActivityLabel(currentStep == null ? [] : [currentStep]);
  const currentStartedAtMs = currentStep?.startedAtMs ?? live.startedAtMs;
  const inspectCurrentWork =
    currentStep?.kind === "llm"
      ? onInspectLlmRequest == null
        ? undefined
        : () => onInspectLlmRequest(currentStep.llmRequestOffset)
      : currentStep?.kind === "code"
        ? onInspectScriptExecution == null
          ? undefined
          : () => onInspectScriptExecution(currentStep.executionId)
        : undefined;

  if (!working) {
    return (
      <AgentActivityRow
        activity={live}
        expanded={toggledIds.has(live.id)}
        onToggle={onToggle}
        onInspectLlmRequest={onInspectLlmRequest}
        onInspectScriptExecution={onInspectScriptExecution}
        roundResult={roundResult}
        roundMeta={roundMeta}
      />
    );
  }

  return (
    <div className="flex flex-col py-0.5">
      {doneSteps.length > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={activityExpanded}
          title="Agent activity so far — click to see details"
          onClick={toggleActivity}
          className="-ml-2.5 self-start font-mono text-xs font-normal text-muted-foreground"
          data-testid="agent-live-summary"
        >
          {doneSummary.codeCount > 0 ? (
            <CodeIcon className="size-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />
          ) : (
            <span className="shrink-0 text-[11px] leading-none text-muted-foreground/60">✦</span>
          )}
          <span>
            {formatAgentUiActivitySummary(live, {
              summary: doneSummary,
              interruptedPartialHint: "click to see partial response",
            })}
          </span>
          <ChevronRightIcon
            className={cn(
              "size-2.5 text-muted-foreground/50 transition-transform",
              activityExpanded && "rotate-90",
            )}
            aria-hidden="true"
          />
        </Button>
      ) : null}
      {showStepRail ? (
        <div className="mb-1.5 ml-1 mt-0.5 flex flex-col gap-1 border-l-2 border-muted py-1 pl-4">
          {/* Rounds, like the settled rail — except the round whose llm step is
              still streaming (no code step, so no tab bar yet): its
              thinking/response text streams in place, exactly as before. */}
          {groupActivityRounds(live.steps).map((round, index) =>
            round.code == null && round.llm != null && round.llm.status === "running" ? (
              round.llm === liveStep && liveStepHasVisibleContent(round.llm) ? (
                <LiveStepStream key={round.llm.id} step={round.llm} />
              ) : null
            ) : (
              <AgentActivityRoundRow
                key={round.code?.id ?? round.llm?.id ?? index}
                round={round}
                index={index}
                roundResult={roundResult}
                roundMeta={roundMeta}
                onInspectLlmRequest={onInspectLlmRequest}
                onInspectScriptExecution={onInspectScriptExecution}
              />
            ),
          )}
        </div>
      ) : null}
      <AgentLiveStatus
        label={currentLabel}
        startedAtMs={currentStartedAtMs}
        deadlineMs={currentStep?.kind === "code" ? currentStep.expiresAtMs : null}
        onInspect={inspectCurrentWork}
      />
    </div>
  );
}

/** The only subtree subscribed to the 100ms clock; grouped rows stay stable. */
function AgentLiveStatus({
  label,
  startedAtMs,
  deadlineMs,
  onInspect,
}: {
  label: string;
  startedAtMs: number | null;
  deadlineMs: number | null;
  onInspect: (() => void) | undefined;
}) {
  const phaseClock = useLivePhaseClock(startedAtMs, deadlineMs, true);
  const phaseLabel = phaseClock.deadlineExceeded ? "Code deadline exceeded" : label;
  const statusWithElapsed = `${phaseLabel}${phaseClock.elapsedLabel == null ? "" : ` ${phaseClock.elapsedLabel}`}`;

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={onInspect == null}
      onClick={onInspect}
      title={
        phaseClock.deadlineExceeded
          ? "The script has no durable settlement after its absolute deadline"
          : onInspect == null
            ? undefined
            : "Open the current operation's trace"
      }
      className={cn(
        "-ml-2.5 h-7 self-start px-2.5 text-primary disabled:opacity-100",
        phaseClock.deadlineExceeded && "text-destructive",
      )}
      data-testid="agent-live-status"
    >
      {phaseClock.deadlineExceeded ? (
        <CircleAlertIcon className="size-3 shrink-0 text-destructive" />
      ) : (
        <Spinner className="size-3 shrink-0 text-primary" />
      )}
      <span
        className={cn(
          "text-sm font-medium tabular-nums text-primary",
          phaseClock.deadlineExceeded && "text-destructive",
        )}
      >
        {statusWithElapsed}
      </span>
      {onInspect == null ? null : (
        <ChevronRightIcon
          className={cn(
            "size-2.5 text-primary/60",
            phaseClock.deadlineExceeded && "text-destructive/60",
          )}
          aria-hidden="true"
        />
      )}
    </Button>
  );
}

function liveStepHasVisibleContent(step: AgentUiStep) {
  if (step.kind === "code") return step.code !== "";
  return step.thinkingText !== "" || step.responseText !== "";
}

/**
 * Live CLI-style elapsed counter (`0.9s`) for the current agent phase. Ticks
 * every 100ms so reasoning, response waits, and code runs all count upward.
 * A script clock stops at its authoritative absolute deadline and flips to an
 * explicit failure state even if the durable completion is delayed.
 * Clock is a useSyncExternalStore subscription (react-doctor happy path),
 * not a useState+setInterval effect loop.
 */
function useLivePhaseClock(
  startedAtMs: number | null,
  deadlineMs: number | null,
  enabled: boolean,
): { deadlineExceeded: boolean; elapsedLabel: string | null } {
  const nowMs = useTickingNowMs(100, enabled && startedAtMs != null, deadlineMs);
  if (startedAtMs == null) return { deadlineExceeded: false, elapsedLabel: null };
  const deadlineExceeded = deadlineMs != null && nowMs >= deadlineMs;
  return {
    deadlineExceeded,
    elapsedLabel: formatElapsedSeconds(
      (deadlineExceeded && deadlineMs != null ? deadlineMs : nowMs) - startedAtMs,
    ),
  };
}

function LiveStepStream({ step }: { step: AgentUiStep }) {
  if (step.kind === "code") {
    return (
      <div className="flex flex-col gap-1.5 py-1">
        {step.code === "" ? null : <StreamingCodeBlock code={step.code} />}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 py-1">
      {step.thinkingText === "" ? null : (
        <div className="max-w-2xl whitespace-pre-wrap px-1.5 text-sm italic leading-relaxed text-muted-foreground">
          {step.thinkingText}
          {step.responseText === "" ? <StreamingCursor /> : null}
        </div>
      )}
      {step.responseText === "" ? null : looksLikeCode(step.responseText) ? (
        <StreamingCodeBlock code={step.responseText} />
      ) : (
        <div className="max-w-2xl whitespace-pre-wrap px-1.5 text-sm leading-relaxed">
          <TokenRevealText windows={step.responseWindows} />
          <StreamingCursor />
        </div>
      )}
    </div>
  );
}

/** The streamed response, one span per token with a CSS stagger: chunk events
 * arrive as ~150ms coalescing windows (~8 tokens each), and rendering a window
 * in one jump reads as chugging. Each window fans its tokens' animation-delay
 * across the gap to the next window instead — CSS is the clock, so there are
 * no timers and no extra re-renders. Keys are stable and windows are
 * append-only, so finished windows keep their DOM nodes and never re-animate.
 * The `token-in` keyframes live in the shared stylesheet (styles/globals.css). */
function TokenRevealText({ windows }: { windows: string[] }) {
  return windows.map((window, windowIndex) => {
    const tokens = window.split(/(?<=\s)/);
    return (
      <span key={windowIndex}>
        {tokens.map((token, tokenIndex) => (
          <span
            key={tokenIndex}
            className="animate-token-in"
            // Fan across ~140ms regardless of token count, so a large window
            // always finishes revealing before the next window's tokens land.
            style={{ animationDelay: `${Math.round((tokenIndex / tokens.length) * 140)}ms` }}
          >
            {token}
          </span>
        ))}
      </span>
    );
  });
}

/** Amber-tinted block the response/code streams into, character by character.
 * Clamped to the same height as settled code and tail-pinned so the newest
 * tokens stay visible: a long codemode turn (minutes, thousands of chunks)
 * otherwise grows to fill the viewport and reads as one never-ending code
 * block. Scrolling up unpins; returning to the bottom re-pins. */
function StreamingCodeBlock({ code }: { code: string }) {
  const preRef = useRef<HTMLPreElement>(null);
  const pinnedRef = useRef(true);
  useLayoutEffect(() => {
    const el = preRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [code]);
  return (
    <pre
      ref={preRef}
      onScroll={(event) => {
        const el = event.currentTarget;
        pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="max-h-80 overflow-y-auto overflow-x-auto whitespace-pre-wrap break-words rounded-xl bg-amber-50 px-4 py-3 font-mono text-xs leading-relaxed text-foreground dark:bg-amber-950/20"
    >
      {code}
      <StreamingCursor className="bg-amber-600" />
    </pre>
  );
}

function StreamingCursor({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "ml-px inline-block h-3.5 w-[7px] animate-caret-blink bg-muted-foreground/40 align-[-2px]",
        className,
      )}
    />
  );
}
