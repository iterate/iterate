// The feed rows, apps/os's agent-feed.tsx at the size this page needs: a person's message, the
// assistant's prose, and the quiet "Ran code 2× · 3 requests · 7.4 s" activity row that opens into
// rounds — the LLM step that wrote a script and the code step that ran it, each a `Script | Result |
// Meta` tab group. Items come from the shared reducer (packages/ui); this file owns only their look.
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  BanIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CodeIcon,
  PaperclipIcon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";
import { sliceText } from "@iterate-com/shared/chunked-text";
import {
  deriveAgentUiLiveStatus,
  formatAgentUiActivitySummary,
  formatAgentUiDuration,
  groupActivityRounds,
  summarizeAgentUiActivity,
  type AgentUiActivity,
  type AgentUiActivityRound,
  type AgentUiCodeStep,
  type AgentUiFileAttachment,
  type AgentUiItem,
  type AgentUiLlmStep,
  type AgentUiState,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@iterate-com/ui/components/ai-elements/message";
import { Button } from "@iterate-com/ui/components/button";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { cn } from "@iterate-com/ui/lib/utils";
import {
  formatClockTime,
  formatDateTime,
  formatFileSize,
  formatSeconds,
  liveActivityLabel,
  looksLikeCode,
} from "../lib/agent-events.ts";

/** The two traces a row can open: an LLM request (by its offset) and a script run (by id). */
export type Inspect = {
  llmRequest: (llmRequestOffset: number) => void;
  scriptExecution: (executionId: string) => void;
};
/** A signed download URL for a file under the agent's path — the page's `itx.files` door. */
export type SignedUrl = (path: string) => Promise<string>;

export function AgentFeedItemRow({
  item,
  expanded,
  onToggle,
  inspect,
  signedUrl,
}: {
  item: AgentUiItem;
  expanded: boolean;
  onToggle: (id: string) => void;
  inspect: Inspect;
  signedUrl: SignedUrl;
}) {
  switch (item.kind) {
    case "user":
      return (
        <Message from="user" className="pb-2 pt-3.5" data-kind="user">
          <MessageContent className="group-[.is-user]:rounded-2xl">
            {item.text === "" ? null : (
              <div className="whitespace-pre-wrap leading-6">{item.text}</div>
            )}
            <MessageAttachments
              files={item.files}
              hasText={item.text !== ""}
              signedUrl={signedUrl}
            />
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
    case "stream-woken":
      // An os-next actor quiesces after a short idle and wakes on the next request, so wakes
      // are a fact of every turn, not a signal — the Events view lists them; the chat does not.
      return null;
    case "processor-revived":
    case "child-stream-created":
      return (
        <div className="flex items-center gap-3 py-3 text-xs text-muted-foreground">
          <div className="h-px flex-1 bg-border/70" />
          <span className="shrink-0 font-mono">
            {item.kind === "processor-revived" ? "Processor revived" : `Created ${item.childPath}`}
          </span>
          <div className="h-px flex-1 bg-border/70" />
        </div>
      );
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

export function AgentActivityRounds({
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
  if (round.llm?.durationMs != null) parts.push(`model ${formatSeconds(round.llm.durationMs)}`);
  if (round.code?.durationMs != null) parts.push(`script ${formatSeconds(round.code.durationMs)}`);
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
  if (llm.durationMs != null) parts.push(formatSeconds(llm.durationMs));
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
        <pre className="max-w-2xl whitespace-pre-wrap px-1.5 font-mono text-xs text-destructive">
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
          <pre className="whitespace-pre-wrap px-1.5 font-mono text-xs text-destructive">
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
                {llm.durationMs == null ? "—" : formatSeconds(llm.durationMs)}
                {llm.outcome && llm.outcome !== "completed" ? ` · ${llm.outcome}` : ""}
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">script</dt>
          <dd>
            {code.durationMs == null ? "running" : formatSeconds(code.durationMs)}
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
export function ScriptResult({ code }: { code: AgentUiCodeStep }) {
  return (
    <>
      {code.errorMessage ? (
        <pre className="whitespace-pre-wrap rounded-lg bg-destructive/5 px-3 py-2 font-mono text-xs leading-relaxed text-destructive">
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

const tickingClock = (() => {
  let now = Date.now();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!timer)
        timer = setInterval(() => {
          now = Date.now();
          listeners.forEach((l) => l());
        }, 100);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    getSnapshot: () => now,
  };
})();

export function AgentLiveActivity({ state, inspect }: { state: AgentUiState; inspect: Inspect }) {
  const now = useSyncExternalStore(tickingClock.subscribe, tickingClock.getSnapshot, () =>
    Date.now(),
  );
  const live = state.live;
  if (!live) return null;
  const running = live.steps.filter((step) => step.status === "running");
  const status = deriveAgentUiLiveStatus(state);
  const label = status?.statusText ?? liveActivityLabel(running);
  const since = running.at(-1)?.startedAtMs ?? live.startedAtMs;
  const settledRounds = groupActivityRounds(live.steps.filter((step) => step.status === "done"));
  const runningCode = running.find((step): step is AgentUiCodeStep => step.kind === "code");
  return (
    <div className="flex flex-col gap-1.5 py-2" data-kind="live">
      {settledRounds.length === 0 ? null : (
        <div className="ml-1 flex flex-col gap-1 border-l-2 border-muted py-1 pl-4">
          <AgentActivityRounds rounds={settledRounds} inspect={inspect} />
        </div>
      )}
      <div className="flex items-center gap-2" role="status">
        <Spinner className="size-3 shrink-0 text-primary" />
        <span className="text-sm font-medium tabular-nums text-primary">
          {label} · {(Math.max(0, now - since) / 1000).toFixed(1)}s
        </span>
      </div>
      {runningCode ? (
        <div className="max-h-80 max-w-2xl overflow-y-auto rounded-lg">
          <SourceCodeBlock code={runningCode.code} language="typescript" showLineNumbers={false} />
        </div>
      ) : null}
    </div>
  );
}

// ── attachments: an image inline through a signed URL, anything else by name ──

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
