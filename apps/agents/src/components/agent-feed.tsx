// The feed rows: a person's message, the assistant's prose, and the quiet "Ran code 2× · 3
// requests · 7.4 s" activity row that opens into rounds — the LLM step that wrote a script and the
// code step that ran it, each a `Script | Result | Meta` tab group. Items come from the shared
// reducer (packages/ui); this file owns only their look.
import { useCallback, useEffect, useState } from "react";
import {
  BanIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CodeIcon,
  PaperclipIcon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { cn } from "cn";
import {
  deriveAgentUiLiveStatus,
  formatAgentUiActivitySummary,
  formatAgentUiDuration,
  groupActivityRounds,
  isAgentUiActivityWorking,
  summarizeAgentUiActivity,
  type AgentUiActivity,
  type AgentUiActivityRound,
  type AgentUiCodeStep,
  type AgentUiFileAttachment,
  type AgentUiItem,
  type AgentUiLlmStep,
  type AgentUiMessageItem,
  type AgentUiState,
  type AgentUiStep,
} from "../lib/events/agent-ui-reducer.ts";
import { sliceText } from "../lib/chunked-text.ts";
import {
  formatClockTime,
  formatDateTime,
  formatElapsedSeconds,
  formatFileSize,
  liveActivityLabel,
  looksLikeCode,
} from "../lib/agent-events.ts";
import { useTickingNowMs } from "../lib/use-ticking-now-ms.ts";
import { SourceCodeBlock } from "./source-code-block.tsx";
import { Message, MessageContent, MessageResponse } from "./message.tsx";
import { StreamingCodeBlock, StreamingCursor, StreamingText } from "./streaming-text.tsx";

/** The two traces a row can open: an LLM request (by its offset) and a script run (by id). */
export type Inspect = {
  llmRequest: (llmRequestOffset: number) => void;
  scriptExecution: (executionId: string) => void;
};
/** A signed download URL for a file under the agent's path — the page's `itx.files` call. */
export type SignedUrl = (path: string) => Promise<string>;

export function AgentFeedItemRow({
  item,
  expanded,
  onToggle,
  inspect,
  traceOffset,
  signedUrl,
}: {
  item: AgentUiItem;
  expanded: boolean;
  onToggle: (id: string) => void;
  inspect: Inspect;
  /** The llm request behind an assistant message, so its bubble opens the trace on hover. */
  traceOffset: number | undefined;
  signedUrl: SignedUrl;
}) {
  switch (item.kind) {
    case "user":
      return (
        <Message from="user" className="pb-2 pt-3.5" data-kind="user">
          <MessageContent className="group-[.is-user]:rounded-2xl">
            <UserMessageBody item={item} signedUrl={signedUrl} />
          </MessageContent>
        </Message>
      );
    case "assistant":
      return (
        <Message from="assistant" className="py-2" data-kind="assistant">
          <MessageContent>
            {/* Settled text never streams: static mode renders synchronously and skips the
                unpaired-marker balancing that appends a phantom `*` to "17 * 23". */}
            <MessageResponse
              className="min-w-0 max-w-full overflow-hidden"
              mode="static"
              parseIncompleteMarkdown={false}
            >
              {item.text}
            </MessageResponse>
            <MessageAttachments
              files={item.files}
              hasText={item.text !== ""}
              signedUrl={signedUrl}
            />
            {traceOffset === undefined ? null : (
              <button
                type="button"
                onClick={() => inspect.llmRequest(traceOffset)}
                className="self-start text-[11px] text-muted-foreground/60 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                title="See the model's raw response and the code this turn ran"
              >
                trace ›
              </button>
            )}
          </MessageContent>
        </Message>
      );
    case "activity":
      return (
        <AgentActivityRow
          activity={item}
          expanded={expanded}
          onToggle={onToggle}
          inspect={inspect}
        />
      );
    case "stream-paused":
    case "stream-resumed": {
      const Icon = item.kind === "stream-paused" ? PauseIcon : PlayIcon;
      return (
        <div className="flex items-center gap-3 py-3" data-kind={item.kind}>
          <div className="h-px flex-1 bg-border" />
          <div className="flex min-w-0 shrink items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-muted-foreground">
            <Icon className="size-3.5 shrink-0" aria-hidden="true" />
            <time className="truncate text-xs font-medium" title={formatDateTime(item.timestampMs)}>
              {item.reason ? `${item.text}: ${item.reason}` : item.text}
            </time>
          </div>
          <div className="h-px flex-1 bg-border" />
        </div>
      );
    }
  }
}

// ── the settled activity: the quiet "Ran code 2× · 3 requests · 7.4 s" row ──

function AgentActivityRow({
  activity,
  expanded,
  onToggle,
  inspect,
}: {
  activity: AgentUiActivity;
  expanded: boolean;
  onToggle: (id: string) => void;
  inspect: Inspect;
}) {
  const summary = summarizeAgentUiActivity(activity);
  const failed = summary.outcome === "failed";
  // The agent's own latest status line for this stretch of work leads the stats.
  const activityLabel = [...activity.steps]
    .reverse()
    .flatMap((step) => (step.kind === "code" && step.activitySummary ? [step.activitySummary] : []))
    .at(0);
  return (
    <div className="flex flex-col py-0.5" data-kind="activity">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        title="Agent activity — click to see what it did"
        onClick={() => onToggle(activity.id)}
        className={cn(
          "-ml-2.5 self-start font-medium text-muted-foreground",
          failed && "text-destructive hover:text-destructive",
        )}
      >
        {failed ? (
          <CircleAlertIcon data-icon="inline-start" className="text-destructive" />
        ) : summary.outcome === "interrupted" ? (
          <BanIcon data-icon="inline-start" className="text-destructive" />
        ) : (
          <CodeIcon data-icon="inline-start" className="text-muted-foreground/60" />
        )}
        {!activityLabel || summary.outcome !== "clean"
          ? `${activityLabel ? `${activityLabel} · ` : ""}${formatAgentUiActivitySummary(activity, {
              summary,
              interruptedPartialHint: "click to see partial response",
            })}`
          : [
              activityLabel,
              activity.endedAtMs
                ? formatAgentUiDuration(Math.max(0, activity.endedAtMs - activity.startedAtMs))
                : "",
            ]
              .filter(Boolean)
              .join(" · ")}
        <ChevronRightIcon
          data-icon="inline-end"
          className={cn("text-muted-foreground/50 transition-transform", expanded && "rotate-90")}
        />
      </Button>
      {expanded ? (
        <div className="mb-1.5 ml-1 mt-0.5 flex flex-col gap-1 border-l-2 border-muted py-1 pl-4">
          <AgentActivityRounds rounds={groupActivityRounds(activity.steps)} inspect={inspect} />
        </div>
      ) : null}
    </div>
  );
}

// ── rounds: the llm step that wrote a script and the code step that ran it ──

function AgentActivityRounds({
  rounds,
  inspect,
}: {
  rounds: AgentUiActivityRound[];
  inspect: Inspect;
}) {
  if (rounds.length === 1) return <RoundBody round={rounds[0]!} inspect={inspect} />;
  return (
    <>
      {rounds.map((round, index) => (
        <RoundRow
          key={round.code?.id ?? round.llm?.id ?? index}
          round={round}
          index={index}
          inspect={inspect}
        />
      ))}
    </>
  );
}

function RoundRow({
  round,
  index,
  inspect,
}: {
  round: AgentUiActivityRound;
  index: number;
  inspect: Inspect;
}) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const expanded = toggled ?? round.code?.status === "running";
  const failed = round.code?.success === false || round.llm?.outcome === "failed";
  return (
    <div className="flex flex-col items-start">
      <Button
        variant="ghost"
        size="xs"
        aria-expanded={expanded}
        onClick={() => setToggled(!expanded)}
        className={cn(
          "-ml-2 max-w-full self-start font-normal",
          failed && "text-destructive hover:text-destructive",
        )}
      >
        <span
          className={cn(
            "shrink-0 font-mono text-xs text-foreground/70",
            failed && "text-destructive",
          )}
        >
          Round {index + 1}
        </span>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground/70">
          {roundHeaderMeta(round)}
        </span>
        <ChevronRightIcon
          data-icon="inline-end"
          className={cn("text-muted-foreground/50 transition-transform", expanded && "rotate-90")}
        />
      </Button>
      {expanded ? (
        <div className="w-full py-1">
          <RoundBody round={round} inspect={inspect} />
        </div>
      ) : null}
    </div>
  );
}

function roundHeaderMeta(round: AgentUiActivityRound): string {
  const parts: string[] = [];
  if (round.code?.activitySummary) parts.push(round.code.activitySummary);
  else if (round.llm) parts.push(formatClockTime(round.llm.startedAtMs));
  if (round.llm?.durationMs != null)
    parts.push(`model ${formatAgentUiDuration(round.llm.durationMs)}`);
  if (round.code?.durationMs != null)
    parts.push(`script ${formatAgentUiDuration(round.code.durationMs)}`);
  return parts.join(" · ");
}

function RoundBody({ round, inspect }: { round: AgentUiActivityRound; inspect: Inspect }) {
  if (!round.code) return round.llm ? <LlmOnlyRound llm={round.llm} inspect={inspect} /> : null;
  return <RoundTabs llm={round.llm} code={round.code} inspect={inspect} />;
}

function llmStepLabel(llm: AgentUiLlmStep): string {
  if (llm.status === "running") return "Waiting for a response";
  if (llm.outcome === "failed") return "Request failed";
  if (llm.outcome === "cancelled")
    return llm.cancelReason === "expired" ? "Request expired" : "Request cancelled";
  return llm.model || "Response";
}

function llmStepMeta(llm: AgentUiLlmStep): string {
  const parts = [formatClockTime(llm.startedAtMs)];
  if (llm.durationMs != null) parts.push(formatAgentUiDuration(llm.durationMs));
  return parts.join(" · ");
}

/** A round with no code step: a plain reply, or a failed request. An INTERPRETED response (the
 *  prose outside the tag became the chat bubble) renders muted: source material, not the reply. */
function LlmOnlyRound({ llm, inspect }: { llm: AgentUiLlmStep; inspect: Inspect }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex items-center gap-2 px-1.5">
        <span
          className={cn(
            "font-mono text-xs text-foreground/70",
            llm.outcome !== "completed" && "text-destructive",
          )}
        >
          {llmStepLabel(llm)}
        </span>
        <span className="font-mono text-xs text-muted-foreground/70">{llmStepMeta(llm)}</span>
        <FullTraceButton onClick={() => inspect.llmRequest(llm.llmRequestOffset)} />
      </div>
      <LlmResponseText llm={llm} />
    </div>
  );
}

function LlmResponseText({ llm }: { llm: AgentUiLlmStep }) {
  const text = sliceText(llm.responseText);
  return (
    <>
      {text.length === 0 ? null : looksLikeCode(text) ? (
        <div className={cn("w-full max-w-2xl", llm.interpreted && "opacity-75")}>
          <SourceCodeBlock code={text} language="typescript" showLineNumbers={false} />
        </div>
      ) : (
        <div
          className={cn(
            "max-w-2xl whitespace-pre-wrap px-1.5 text-sm leading-relaxed",
            llm.interpreted && "text-muted-foreground",
          )}
        >
          {text}
        </div>
      )}
      {llm.errorMessage ? (
        <pre
          data-type="error"
          className="max-w-2xl whitespace-pre-wrap px-1.5 font-mono text-xs text-destructive"
        >
          {llm.errorMessage}
        </pre>
      ) : null}
    </>
  );
}

function FullTraceButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="xs"
      title="Open this LLM request trace"
      onClick={onClick}
      className="-ml-1 font-normal text-muted-foreground"
    >
      Full trace
      <ChevronRightIcon data-icon="inline-end" className="text-muted-foreground/50" />
    </Button>
  );
}

function RoundTabs({
  llm,
  code,
  inspect,
}: {
  llm: AgentUiLlmStep | null;
  code: AgentUiCodeStep;
  inspect: Inspect;
}) {
  const [selected, setSelected] = useState("script");
  // Every settled script has a result pane — a `return;` that ended the turn says so there.
  const hasResult = code.status === "done";
  const active = selected === "result" && !hasResult ? "script" : selected;
  return (
    <Tabs
      value={active}
      onValueChange={(value) => setSelected(String(value))}
      className="w-full gap-1.5"
    >
      <TabsList variant="line" className="h-7">
        <TabsTrigger value="script" className="text-xs">
          Script
        </TabsTrigger>
        {hasResult ? (
          <TabsTrigger value="result" className="text-xs">
            Result
          </TabsTrigger>
        ) : null}
        <TabsTrigger value="meta" className="text-xs">
          Meta
        </TabsTrigger>
      </TabsList>
      <TabsContent value="script" className="flex flex-col gap-1.5">
        <div className="max-h-80 overflow-y-auto rounded-lg">
          <SourceCodeBlock code={code.code} language="typescript" showLineNumbers={false} />
        </div>
        {!hasResult && code.errorMessage ? (
          <pre
            data-type="error"
            className="whitespace-pre-wrap px-1.5 font-mono text-xs text-destructive"
          >
            {code.errorMessage}
          </pre>
        ) : null}
        <Button
          variant="ghost"
          size="xs"
          title="Open this script's execution trace"
          onClick={() => inspect.scriptExecution(code.executionId)}
          className="-ml-2 self-start font-normal text-muted-foreground"
        >
          Execution trace
          <ChevronRightIcon data-icon="inline-end" className="text-muted-foreground/50" />
        </Button>
      </TabsContent>
      <TabsContent value="result" className="flex flex-col gap-2">
        <ScriptResult code={code} />
      </TabsContent>
      <TabsContent value="meta" className="flex flex-col gap-1.5">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-1.5 font-mono text-xs">
          {llm ? (
            <>
              <dt className="text-muted-foreground">model</dt>
              <dd>{llm.model || "?"}</dd>
              <dt className="text-muted-foreground">requested</dt>
              <dd>{formatDateTime(llm.startedAtMs)}</dd>
              <dt className="text-muted-foreground">response</dt>
              <dd>
                {llm.durationMs == null ? "—" : formatAgentUiDuration(llm.durationMs)}
                {llm.outcome && llm.outcome !== "completed" ? ` · ${llm.outcome}` : ""}
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">script</dt>
          <dd>
            {code.durationMs == null ? "running" : formatAgentUiDuration(code.durationMs)}
            {code.success === false ? " · failed" : ""}
          </dd>
          <dt className="text-muted-foreground">execution</dt>
          <dd className="truncate">{code.executionId}</dd>
        </dl>
        {llm ? <FullTraceButton onClick={() => inspect.llmRequest(llm.llmRequestOffset)} /> : null}
      </TabsContent>
    </Tabs>
  );
}

/** The script's returned value: a string as itself, anything else as YAML with a JSON toggle. */
function ScriptResult({ code }: { code: AgentUiCodeStep }) {
  return (
    <>
      {code.errorMessage ? (
        <pre
          data-type="error"
          className="whitespace-pre-wrap rounded-lg bg-destructive/5 px-3 py-2 font-mono text-xs leading-relaxed text-destructive"
        >
          {code.errorMessage}
        </pre>
      ) : null}
      {code.result === undefined ? (
        code.errorMessage ? null : (
          <p className="px-1.5 text-xs text-muted-foreground">
            Returned nothing — the turn ended here.
          </p>
        )
      ) : typeof code.result === "string" ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed">
          {code.result}
        </pre>
      ) : (
        <div className="max-h-80 overflow-y-auto rounded-lg">
          <SerializedObjectCodeBlock
            data={code.result}
            initialFormat="yaml"
            showToggle
            showCopyButton
          />
        </div>
      )}
    </>
  );
}

// ── the live tail: what the agent is doing right now ──

/** The feed's trailing row whenever work is in flight. Receives the live reduced state on every
 *  chunk: finished steps collapse upward into quiet rows while the current request or script keeps
 *  the busy indicator visible — the running answer streams in place. */
export function AgentLiveActivity({
  state,
  toggledIds,
  onToggle,
  inspect,
}: {
  state: AgentUiState;
  toggledIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  inspect: Inspect;
}) {
  const live = state.live;
  const activityToggleId = live ? `live-activity:${live.id}` : "";
  const toggleActivity = useCallback(
    () => onToggle(activityToggleId),
    [activityToggleId, onToggle],
  );
  if (!live) return null;
  const runningSteps = live.steps.filter((step) => step.status === "running");
  const liveStep = runningSteps.at(-1);
  const doneSteps = live.steps.filter((step) => step.status === "done");
  const doneSummary = summarizeAgentUiActivity(live, doneSteps);
  const working = isAgentUiActivityWorking(live);
  const activityExpanded = toggledIds.has(activityToggleId);
  const showStepRail =
    activityExpanded &&
    (doneSteps.length > 0 ||
      runningSteps.some((step) => step.kind === "code" || liveStepHasVisibleContent(step)));

  if (!working) {
    // Nothing runs, but the turn is not over (a follow-up round may come): the quiet row.
    return (
      <AgentActivityRow
        activity={live}
        expanded={toggledIds.has(live.id)}
        onToggle={onToggle}
        inspect={inspect}
      />
    );
  }

  const status = deriveAgentUiLiveStatus(state);
  const currentLabel = status?.statusText || liveActivityLabel(runningSteps);
  const currentStartedAtMs = liveStep?.startedAtMs ?? live.startedAtMs;
  const inspectCurrentWork =
    liveStep?.kind === "llm"
      ? () => inspect.llmRequest(liveStep.llmRequestOffset)
      : liveStep?.kind === "code"
        ? () => inspect.scriptExecution(liveStep.executionId)
        : undefined;

  return (
    <div className="flex flex-col py-0.5" data-kind="live">
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
          {/* Rounds, like the settled rail — except the round whose llm step is still streaming
              (no code step, so no tab bar yet): its thinking/response text streams in place. */}
          {groupActivityRounds(live.steps).map((round, index) =>
            !round.code && round.llm && round.llm.status === "running" ? (
              round.llm === liveStep && liveStepHasVisibleContent(round.llm) ? (
                <LiveStepStream key={round.llm.id} step={round.llm} />
              ) : null
            ) : (
              <RoundRow
                key={round.code?.id ?? round.llm?.id ?? index}
                round={round}
                index={index}
                inspect={inspect}
              />
            ),
          )}
        </div>
      ) : null}
      {/* The running answer streams below the status even when the rail is collapsed — this is
          the whole point of the live tail. */}
      {!showStepRail && liveStep && liveStepHasVisibleContent(liveStep) ? (
        <LiveStepStream step={liveStep} />
      ) : null}
      <AgentLiveStatus
        label={currentLabel}
        startedAtMs={currentStartedAtMs}
        deadlineMs={liveStep?.kind === "code" ? liveStep.expiresAtMs : null}
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
  startedAtMs: number;
  deadlineMs: number | null;
  onInspect: (() => void) | undefined;
}) {
  const phaseClock = useLivePhaseClock(startedAtMs, deadlineMs);
  const phaseLabel = phaseClock.deadlineExceeded ? "Code deadline exceeded" : label;
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={!onInspect}
      onClick={onInspect}
      title={
        phaseClock.deadlineExceeded
          ? "The script has no durable settlement after its absolute deadline"
          : onInspect
            ? "Open the current operation's trace"
            : undefined
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
        {phaseLabel} {phaseClock.elapsedLabel}
      </span>
      {onInspect ? (
        <ChevronRightIcon
          className={cn(
            "size-2.5 text-primary/60",
            phaseClock.deadlineExceeded && "text-destructive/60",
          )}
          aria-hidden="true"
        />
      ) : null}
    </Button>
  );
}

function liveStepHasVisibleContent(step: AgentUiStep) {
  if (step.kind === "code") return step.code !== "";
  return step.thinkingText.length > 0 || step.responseText.length > 0;
}

/** Live CLI-style elapsed counter (`0.9s`) for the current agent phase, ticking every 100ms. A
 *  script clock stops at its absolute deadline and flips to an explicit failure state even if the
 *  durable completion is delayed. */
function useLivePhaseClock(
  startedAtMs: number,
  deadlineMs: number | null,
): { deadlineExceeded: boolean; elapsedLabel: string } {
  const nowMs = useTickingNowMs(100, deadlineMs);
  const deadlineExceeded = typeof deadlineMs === "number" && nowMs >= deadlineMs;
  return {
    deadlineExceeded,
    elapsedLabel: formatElapsedSeconds(
      (deadlineExceeded && typeof deadlineMs === "number" ? deadlineMs : nowMs) - startedAtMs,
    ),
  };
}

/** The running step's text as it streams: thinking in italics, the answer as prose or, once it
 *  reads as code, a plain code block (highlighting belongs to settled output). */
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
      {step.thinkingText.length === 0 ? null : (
        <div className="max-w-2xl whitespace-pre-wrap px-1.5 text-sm italic leading-relaxed text-muted-foreground">
          <StreamingText text={step.thinkingText} />
          {step.responseText.length === 0 ? <StreamingCursor /> : null}
        </div>
      )}
      {step.responseText.length === 0 ? null : looksLikeCode(step.responseText) ? (
        <StreamingCodeBlock code={step.responseText} />
      ) : (
        <div className="max-w-2xl whitespace-pre-wrap px-1.5 text-sm leading-relaxed">
          <StreamingText text={step.responseText} animate />
          <StreamingCursor />
        </div>
      )}
    </div>
  );
}

// ── attachments: an image inline through a signed URL, anything else by name ──

/** A person's words and what rode with them — the chat bubble's body, and the queued panel's. */
export function UserMessageBody({
  item,
  signedUrl,
}: {
  item: AgentUiMessageItem;
  signedUrl: SignedUrl;
}) {
  return (
    <>
      {item.text === "" ? null : <div className="whitespace-pre-wrap leading-6">{item.text}</div>}
      <MessageAttachments files={item.files} hasText={item.text !== ""} signedUrl={signedUrl} />
    </>
  );
}

function MessageAttachments({
  files,
  hasText,
  signedUrl,
}: {
  files: AgentUiFileAttachment[] | undefined;
  hasText: boolean;
  signedUrl: SignedUrl;
}) {
  if (!files?.length) return null;
  return (
    <div className={cn("flex max-w-full flex-col gap-2", hasText && "mt-1")}>
      {files.map((file) => (
        <MessageAttachment key={file.path} file={file} signedUrl={signedUrl} />
      ))}
    </div>
  );
}

function MessageAttachment({
  file,
  signedUrl,
}: {
  file: AgentUiFileAttachment;
  signedUrl: SignedUrl;
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let live = true;
    signedUrl(file.path).then(
      (signed) => live && setUrl(signed),
      () => undefined,
    );
    return () => void (live = false);
  }, [file.path, signedUrl]);
  if (file.contentType.startsWith("image/") && url)
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block max-w-full">
        <img
          src={url}
          alt={file.filename}
          className="max-h-64 max-w-full rounded-lg border border-border/60 bg-background object-contain"
        />
      </a>
    );
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-full items-center gap-1.5 self-start rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <PaperclipIcon className="size-3 shrink-0" />
      <span className="min-w-0 truncate text-foreground/80">{file.filename}</span>
      <span className="shrink-0 font-mono">{formatFileSize(file.size)}</span>
    </a>
  );
}
