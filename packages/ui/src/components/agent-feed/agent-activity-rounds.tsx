import { useMemo, useState, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import type {
  AgentUiActivityRound,
  AgentUiCodeStep,
  AgentUiLlmStep,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { Button } from "@iterate-com/ui/components/button";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { cn } from "@iterate-com/ui/lib/utils";
import {
  formatClockTime,
  formatSeconds,
  formatTokens,
  looksLikeCode,
} from "@iterate-com/ui/components/events/feed-format";
import { buildRoundMetaYaml, resultYaml } from "./agent-round-meta-yaml.ts";
import { MAX_HIGHLIGHTED_SCRIPT_RESULT_CHARACTERS } from "./script-result-preview.ts";

// The web feed's ROUND rendering: an expanded "Ran code N×" activity is a list
// of rounds (the llm step that writes a script and the code step that runs
// it, grouped by the shared groupActivityRounds), each a tabbed view
// `Script | Result | Meta`. Meta holds the stat lines that used to spend a
// feed row per llm request (model, duration, tokens) plus the round's exact
// replayed prompt as one YAML doc.
//
// Shared by the web apps, and a deliberate STRUCTURAL TWIN of mobile's
// (React Native, so not shared) activity card (apps/mobile/src/components/activity-card.tsx — see
// CodeStepTabs and metaYaml there): same round grouping, same tab order, same
// Meta YAML shape. Mobile additionally renders an Approvals tab between
// Script and Result (approval batches derived from root-stream events, which
// this feed doesn't have wired in yet) and streams thinking text inline. If
// you change the round/tab/Meta structure on one surface, ask whether the
// other should follow. Known divergence: this feed's Result tab can show the
// AGENT-VISIBLE settlement render (queried from the raw-event mirror, which
// mobile doesn't have wired in) — the default whenever that render was
// truncated/transformed, a toggle away otherwise; mobile still shows only
// the raw result. That render, and the Meta tab's replayed prompt, are
// app-side render props (`roundResult` / `roundMeta`): this package has no
// event mirror, so without them the tabs show the raw result and the
// stats-only Meta YAML.

/**
 * The rounds rail of one settled (or fully-grouped live) activity. A single
 * round skips its "Round 1" header and renders the tabs directly — the
 * activity summary row above already carries the identity; several rounds
 * each get a collapsible "Round N" header row.
 */
export function AgentActivityRounds({
  rounds,
  roundResult,
  roundMeta,
  onInspectLlmRequest,
  onInspectScriptExecution,
}: {
  rounds: AgentUiActivityRound[];
  /** The Result tab body of a settled code step; absent, the raw result renders alone. */
  roundResult?: (code: AgentUiCodeStep) => ReactNode;
  /**
   * The Meta tab body of a round that has an llm step (the app replays the
   * exact prompt there); absent, the tab shows the round's stats YAML only.
   */
  roundMeta?: (llm: AgentUiLlmStep, code: AgentUiCodeStep) => ReactNode;
  onInspectLlmRequest?: (llmRequestOffset: number) => void;
  onInspectScriptExecution?: (executionId: string) => void;
}) {
  if (rounds.length === 1) {
    return (
      <RoundBody
        round={rounds[0]!}
        roundResult={roundResult}
        roundMeta={roundMeta}
        onInspectLlmRequest={onInspectLlmRequest}
        onInspectScriptExecution={onInspectScriptExecution}
      />
    );
  }
  return (
    <>
      {rounds.map((round, index) => (
        <AgentActivityRoundRow
          key={round.code?.id ?? round.llm?.id ?? index}
          round={round}
          index={index}
          roundResult={roundResult}
          roundMeta={roundMeta}
          onInspectLlmRequest={onInspectLlmRequest}
          onInspectScriptExecution={onInspectScriptExecution}
        />
      ))}
    </>
  );
}

/**
 * One collapsible "Round N" row. Rounds whose code step is still running
 * stream open (watch the run live); settled rounds collapse to the header
 * until clicked.
 */
export function AgentActivityRoundRow({
  round,
  index,
  roundResult,
  roundMeta,
  onInspectLlmRequest,
  onInspectScriptExecution,
}: {
  round: AgentUiActivityRound;
  index: number;
  /** See {@link AgentActivityRounds}. */
  roundResult?: (code: AgentUiCodeStep) => ReactNode;
  /** See {@link AgentActivityRounds}. */
  roundMeta?: (llm: AgentUiLlmStep, code: AgentUiCodeStep) => ReactNode;
  onInspectLlmRequest?: (llmRequestOffset: number) => void;
  onInspectScriptExecution?: (executionId: string) => void;
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
        data-testid="agent-feed-round"
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
        {/* Summaries aren't forced short — truncate rather than wrap the header. */}
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
          <RoundBody
            round={round}
            roundResult={roundResult}
            roundMeta={roundMeta}
            onInspectLlmRequest={onInspectLlmRequest}
            onInspectScriptExecution={onInspectScriptExecution}
          />
        </div>
      ) : null}
    </div>
  );
}

function RoundBody({
  round,
  roundResult,
  roundMeta,
  onInspectLlmRequest,
  onInspectScriptExecution,
}: {
  round: AgentUiActivityRound;
  roundResult?: (code: AgentUiCodeStep) => ReactNode;
  roundMeta?: (llm: AgentUiLlmStep, code: AgentUiCodeStep) => ReactNode;
  onInspectLlmRequest?: (llmRequestOffset: number) => void;
  onInspectScriptExecution?: (executionId: string) => void;
}) {
  if (round.code == null) {
    return round.llm == null ? null : (
      <LlmOnlyRound llm={round.llm} onInspectLlmRequest={onInspectLlmRequest} />
    );
  }
  return (
    <RoundTabs
      llm={round.llm}
      code={round.code}
      roundResult={roundResult}
      roundMeta={roundMeta}
      onInspectLlmRequest={onInspectLlmRequest}
      onInspectScriptExecution={onInspectScriptExecution}
    />
  );
}

/**
 * A round with no code step: a plain reply, a cancelled/failed request, or a
 * request whose code half never arrived. No tab bar (mirroring mobile's
 * LlmStepView) — model + stats render as one quiet line with an explicit
 * "Full trace" button, and the response body below. An INTERPRETED response
 * (a userland format extracted its consequences — the chat bubble outside
 * this group is the real reply) renders muted: it is source material, one
 * group-expand away instead of double-nested.
 */
function LlmOnlyRound({
  llm,
  onInspectLlmRequest,
}: {
  llm: AgentUiLlmStep;
  onInspectLlmRequest?: (llmRequestOffset: number) => void;
}) {
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
        {onInspectLlmRequest == null ? null : (
          <Button
            variant="ghost"
            size="xs"
            title="Open this LLM request trace"
            data-testid="agent-feed-inspect-llm-request"
            onClick={() => onInspectLlmRequest(llm.llmRequestOffset)}
            className="-ml-1 font-normal text-muted-foreground"
          >
            Full trace
            <ChevronRightIcon data-icon="inline-end" className="text-muted-foreground/50" />
          </Button>
        )}
      </div>
      {llm.thinkingText === "" ? null : (
        <div className="max-w-2xl whitespace-pre-wrap px-1.5 text-sm italic leading-relaxed text-muted-foreground">
          {llm.thinkingText}
        </div>
      )}
      {llm.responseText === "" ? null : looksLikeCode(llm.responseText) ? (
        <div
          className={cn("w-full max-w-2xl", llm.interpreted && "opacity-75")}
          data-testid={llm.interpreted ? "agent-feed-raw-response" : undefined}
        >
          <SourceCodeBlock code={llm.responseText} language="typescript" showLineNumbers={false} />
        </div>
      ) : (
        <div
          className={cn(
            "max-w-2xl whitespace-pre-wrap px-1.5 text-sm leading-relaxed",
            llm.interpreted && "text-muted-foreground",
          )}
          data-testid={llm.interpreted ? "agent-feed-raw-response" : undefined}
        >
          {llm.responseText}
        </div>
      )}
      {llm.errorMessage == null ? null : (
        <pre className="max-w-2xl whitespace-pre-wrap px-1.5 font-mono text-xs text-destructive">
          {llm.errorMessage}
        </pre>
      )}
    </div>
  );
}

function RoundTabs({
  llm,
  code,
  roundResult,
  roundMeta,
  onInspectLlmRequest,
  onInspectScriptExecution,
}: {
  llm: AgentUiLlmStep | null;
  code: AgentUiCodeStep;
  roundResult?: (code: AgentUiCodeStep) => ReactNode;
  roundMeta?: (llm: AgentUiLlmStep, code: AgentUiCodeStep) => ReactNode;
  onInspectLlmRequest?: (llmRequestOffset: number) => void;
  onInspectScriptExecution?: (executionId: string) => void;
}) {
  const [selected, setSelected] = useState("script");
  const hasResult =
    code.status === "done" && (code.result !== undefined || code.errorMessage != null);
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
        {hasResult || code.errorMessage == null ? null : (
          <pre className="whitespace-pre-wrap px-1.5 font-mono text-xs text-destructive">
            {code.errorMessage}
          </pre>
        )}
        {onInspectScriptExecution == null ? null : (
          <Button
            variant="ghost"
            size="xs"
            title="Open this script's full execution trace"
            data-testid="agent-feed-inspect-script-execution"
            onClick={() => onInspectScriptExecution(code.executionId)}
            className="-ml-2 self-start font-normal text-muted-foreground"
          >
            Execution trace
            <ChevronRightIcon data-icon="inline-end" className="text-muted-foreground/50" />
          </Button>
        )}
      </TabsContent>
      <TabsContent value="result" className="flex flex-col gap-2">
        {/* The Result tab body: the app's agent-visible render when it has one
            (only while this tab is mounted — inactive base-ui tab panels
            unmount), else the raw view alone. */}
        {roundResult == null ? <RawRoundResult code={code} /> : roundResult(code)}
      </TabsContent>
      <TabsContent value="meta" className="flex flex-col gap-1.5">
        {/* The Meta tab body. The stats YAML renders immediately from the
            reduced steps; the replayed prompt needs the app's raw-event mirror,
            so it only joins the doc through `roundMeta`. */}
        {roundMeta == null || llm == null ? (
          <MetaYamlBlock yamlText={buildRoundMetaYaml(llm, code, null)} />
        ) : (
          roundMeta(llm, code)
        )}
        {llm == null || onInspectLlmRequest == null ? null : (
          <Button
            variant="ghost"
            size="xs"
            title="Open this LLM request trace"
            data-testid="agent-feed-inspect-llm-request"
            onClick={() => onInspectLlmRequest(llm.llmRequestOffset)}
            className="-ml-2 self-start font-normal text-muted-foreground"
          >
            Full trace
            <ChevronRightIcon data-icon="inline-end" className="text-muted-foreground/50" />
          </Button>
        )}
      </TabsContent>
    </Tabs>
  );
}

/** The raw settlement of a code step: its error, then its result as YAML. */
export function RawRoundResult({ code }: { code: AgentUiCodeStep }) {
  // One YAML fold for every size; only the RENDERER is bounded — CodeMirror
  // is expensive near the stream event-size ceiling, so oversized results get
  // a plain-text preview of the same YAML instead of falling back to JSON.
  const yaml = useMemo(
    () => (code.result === undefined ? null : resultYaml(code.result)),
    [code.result],
  );
  return (
    <>
      {code.errorMessage == null ? null : (
        <pre className="whitespace-pre-wrap rounded-lg bg-destructive/5 px-3 py-2 font-mono text-xs leading-relaxed text-destructive">
          {code.errorMessage}
        </pre>
      )}
      {yaml == null ? null : yaml.length <= MAX_HIGHLIGHTED_SCRIPT_RESULT_CHARACTERS ? (
        <div className="max-h-80 overflow-y-auto rounded-lg" data-testid="script-result-raw">
          <SourceCodeBlock code={yaml} language="yaml" showLineNumbers={false} />
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-muted/20">
          <p className="border-b px-3 py-2 text-xs text-muted-foreground">
            This result is {yaml.length.toLocaleString()} characters as YAML. Showing the first{" "}
            {MAX_HIGHLIGHTED_SCRIPT_RESULT_CHARACTERS / 1024} KB without syntax highlighting.
          </p>
          <pre
            className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed"
            data-testid="script-result-bounded-preview"
          >
            {yaml.slice(0, MAX_HIGHLIGHTED_SCRIPT_RESULT_CHARACTERS)}
            {"\n…"}
          </pre>
        </div>
      )}
    </>
  );
}

/** The Meta tab's scrollable, foldable YAML document. */
export function MetaYamlBlock({ yamlText }: { yamlText: string }) {
  return (
    <div className="max-h-96 overflow-y-auto rounded-lg">
      <SourceCodeBlock
        code={yamlText}
        language="yaml"
        showLineNumbers={false}
        showFoldGutter={true}
      />
    </div>
  );
}

/**
 * The "Round N" header's muted suffix — the at-a-glance facts the old flat
 * step rail used to spend two rows on. When the round carries the agent's
 * summary `activity` (the reducer stamps the latest agent/summary-updated
 * fold onto each code step), that replaces the bare start time: "Searching
 * the five most recent FirstFT emails · 223 ms" instead of "Started
 * 15:28:11 · 223 ms".
 */
function roundHeaderMeta(round: AgentUiActivityRound) {
  const { code, llm } = round;
  if (code != null) {
    const parts = [
      ...(code.status === "running"
        ? ["Running code"]
        : code.success === false
          ? ["Code failed"]
          : []),
      code.activitySummary || `Started ${formatClockTime(code.startedAtMs)}`,
      ...(code.durationMs == null ? [] : [formatSeconds(code.durationMs)]),
      ...(llm?.outcome === "failed" ? ["request failed"] : []),
    ];
    return parts.join(" · ");
  }
  if (llm == null) return "";
  return [llmStepLabel(llm), llmStepMeta(llm)].filter((part) => part !== "").join(" · ");
}

function llmStepLabel(llm: AgentUiLlmStep) {
  if (llm.cancelReason === "interrupted-by-user-input") return "Stopped for your new message";
  if (llm.cancelReason === "expired") return "Request expired";
  if (llm.outcome === "cancelled") return "Request cancelled";
  return llm.model ?? "LLM request";
}

function llmStepMeta(llm: AgentUiLlmStep) {
  const parts: string[] = [];
  if (llm.cancelReason != null && llm.model != null) parts.push(llm.model);
  if (llm.inputTokens != null || llm.outputTokens != null) {
    parts.push(`${formatTokens(llm.inputTokens)} → ${formatTokens(llm.outputTokens)} tok`);
  }
  if (llm.durationMs != null) parts.push(formatSeconds(llm.durationMs));
  if (llm.outcome === "failed") parts.push("failed");
  return parts.join(" · ");
}
