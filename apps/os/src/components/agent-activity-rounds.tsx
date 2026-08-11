import { useMemo, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type {
  AgentUiActivityRound,
  AgentUiCodeStep,
  AgentUiLlmStep,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { MessageResponse } from "@iterate-com/ui/components/ai-elements/message";
import { Button } from "@iterate-com/ui/components/button";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { cn } from "@iterate-com/ui/lib/utils";
import { useStreamQuery } from "~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import { buildRoundMetaYaml, resultYaml } from "~/lib/agent-round-meta-yaml.ts";
import { formatClockTime, formatSeconds, formatTokens, looksLikeCode } from "~/lib/feed-format.ts";
import { LLM_REPLAY_EVENT_TYPES, replayLlmRequest } from "~/lib/llm-request-replay.ts";
import { MAX_HIGHLIGHTED_SCRIPT_RESULT_CHARACTERS } from "~/lib/script-result-preview.ts";
import { stringifyScriptResult } from "~/lib/script-result-render.ts";

/** The canonical model-visible context event; script-actor instances carry the
 * settlement text `renderScriptSettlement` produced for the agent. */
const SCRIPT_RENDER_EVENT_TYPE = "events.iterate.com/agents/context-added";

// The web feed's ROUND rendering: an expanded "Ran code N×" activity is a list
// of rounds (the llm step that writes a script and the code step that runs
// it, grouped by the shared groupActivityRounds), each a tabbed view
// `Script | Result | Meta`. Meta holds the stat lines that used to spend a
// feed row per llm request (model, duration, tokens) plus the round's exact
// replayed prompt as one YAML doc.
//
// NOT a shared component, but a deliberate STRUCTURAL TWIN of mobile's
// activity card (apps/mobile/src/components/activity-card.tsx — see
// CodeStepTabs and metaYaml there): same round grouping, same tab order, same
// Meta YAML shape. Mobile additionally renders an Approvals tab between
// Script and Result (approval batches derived from root-stream events, which
// this feed doesn't have wired in yet) and streams thinking text inline. If
// you change the round/tab/Meta structure on one surface, ask whether the
// other should follow. Known divergence: this feed's Result tab can show the
// AGENT-VISIBLE settlement render (queried from the raw-event mirror, which
// mobile doesn't have wired in) — the default whenever that render was
// truncated/transformed, a toggle away otherwise; mobile still shows only
// the raw result.

/**
 * The rounds rail of one settled (or fully-grouped live) activity. A single
 * round skips its "Round 1" header and renders the tabs directly — the
 * activity summary row above already carries the identity; several rounds
 * each get a collapsible "Round N" header row.
 */
export function AgentActivityRounds({
  rounds,
  database,
  onInspectLlmRequest,
  onInspectScriptExecution,
}: {
  rounds: AgentUiActivityRound[];
  database?: StreamBrowserDatabase;
  onInspectLlmRequest?: (llmRequestOffset: number) => void;
  onInspectScriptExecution?: (executionId: string) => void;
}) {
  if (rounds.length === 1) {
    return (
      <RoundBody
        round={rounds[0]!}
        database={database}
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
          database={database}
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
  database,
  onInspectLlmRequest,
  onInspectScriptExecution,
}: {
  round: AgentUiActivityRound;
  index: number;
  database?: StreamBrowserDatabase;
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
            database={database}
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
  database,
  onInspectLlmRequest,
  onInspectScriptExecution,
}: {
  round: AgentUiActivityRound;
  database?: StreamBrowserDatabase;
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
      database={database}
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
  database,
  onInspectLlmRequest,
  onInspectScriptExecution,
}: {
  llm: AgentUiLlmStep | null;
  code: AgentUiCodeStep;
  database?: StreamBrowserDatabase;
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
        <RoundResult code={code} database={database} />
      </TabsContent>
      <TabsContent value="meta" className="flex flex-col gap-1.5">
        <RoundMeta llm={llm} code={code} database={database} />
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

/**
 * The Result tab body. When the raw-event mirror is available, the agent's
 * view — the exact settlement text `renderScriptSettlement` appended for the
 * model — is one toggle away, and becomes the DEFAULT precisely when that
 * text is a transformed representation (inline truncation at the history
 * limit, or an oversized result replaced by an inferred type + bounded
 * preview + loader recipe): in that case the raw view would misrepresent
 * what the agent could actually see. When the agent saw the full result, the
 * raw view is strictly nicer to read and stays the default. Without a mirror
 * the raw view stands alone, exactly as before.
 */
function RoundResult({
  code,
  database,
}: {
  code: AgentUiCodeStep;
  database?: StreamBrowserDatabase;
}) {
  if (database == null) return <RawRoundResult code={code} />;
  return <AgentRenderedRoundResult code={code} database={database} />;
}

/**
 * The agent-visible settlement render lives ON THE STREAM: a developer
 * `agents/context-added` event stamped `actor: {type: "script", executionId}`
 * — queried from the mirror the same way the Meta tab replays its prompt
 * (only while this tab is mounted; inactive base-ui tab panels unmount). The
 * query is live, so a render event that lands moments after the settlement
 * fills in when it arrives; streams with no render event (predating the
 * server-side render, or non-agent executions) keep the raw view.
 */
function AgentRenderedRoundResult({
  code,
  database,
}: {
  code: AgentUiCodeStep;
  database: StreamBrowserDatabase;
}) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const eventsResult = useStreamQuery(
    database,
    `SELECT json(raw_jsonb) AS raw_json FROM events
     WHERE type = ?
       AND json_extract(raw_jsonb, '$.payload.actor.type') = 'script'
       AND json_extract(raw_jsonb, '$.payload.actor.executionId') = ?
     ORDER BY offset ASC
     LIMIT 1`,
    [SCRIPT_RENDER_EVENT_TYPE, code.executionId],
  );
  const agentText = useMemo(() => {
    const row = eventsResult.data[0];
    if (eventsResult.status !== "ok" || row == null) return null;
    try {
      const parsed = JSON.parse(String(row.raw_json)) as { payload?: { content?: unknown } };
      const content = parsed.payload?.content;
      return typeof content === "string" ? content : null;
    } catch {
      return null;
    }
  }, [eventsResult.status, eventsResult.data]);
  // Wait for the local mirror (it answers in ms) instead of painting the raw
  // view and swapping it out from under the reader.
  if (eventsResult.status === "pending") return null;
  if (agentText == null) return <RawRoundResult code={code} />;
  const showRaw = toggled ?? !renderIsTransformed(code, agentText);
  return (
    <>
      {showRaw ? (
        <RawRoundResult code={code} />
      ) : (
        <div
          className="max-h-80 overflow-y-auto rounded-lg bg-muted/20 px-3 py-2 text-sm"
          data-testid="script-result-agent-view"
        >
          {/* Same settled-markdown path as assistant messages: static mode,
              no unpaired-marker balancing (see agent-feed.tsx). */}
          <MessageResponse
            className="min-w-0 max-w-full overflow-hidden"
            mode="static"
            parseIncompleteMarkdown={false}
          >
            {agentText}
          </MessageResponse>
        </div>
      )}
      <Button
        variant="ghost"
        size="xs"
        data-testid="script-result-view-toggle"
        onClick={() => setToggled(!showRaw)}
        className="-ml-2 self-start font-normal text-muted-foreground"
      >
        {showRaw ? "Show agent view" : "Show raw result"}
      </Button>
    </>
  );
}

/**
 * Did the agent see a TRANSFORMED representation of this settlement, rather
 * than the full thing? Detected structurally: the untransformed render
 * (`renderScriptSettlement` in
 * apps/os/src/domains/agents/agent-processor-implementation.ts) embeds the
 * exact stringified settlement verbatim inside its fence — computed by the
 * SAME `stringifyScriptResult` this check imports (lib/script-result-render),
 * so the coupling is enforced by sharing the implementation, not by
 * convention — while every transforming path (inline truncation at the
 * history limit, oversized spills replaced by an inferred type + elided
 * preview) necessarily drops part of it. So a containment check
 * distinguishes the cases without matching on notice strings. Fail-safe
 * either way: if containment breaks for any other reason, the tab defaults
 * to the agent view — which never misrepresents — rather than to a raw view
 * claiming the agent saw everything.
 */
function renderIsTransformed(code: AgentUiCodeStep, agentText: string): boolean {
  const full =
    code.result !== undefined ? stringifyScriptResult(code.result) : (code.errorMessage ?? null);
  if (full == null) return true;
  return !agentText.includes(full);
}

function RawRoundResult({ code }: { code: AgentUiCodeStep }) {
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

/**
 * The Meta tab body. The stats YAML renders immediately from the reduced
 * steps; the replayed prompt needs the raw-event mirror, so it only joins the
 * doc when the feed has a database (and only queries while this tab is
 * mounted — inactive base-ui tab panels unmount).
 */
function RoundMeta({
  llm,
  code,
  database,
}: {
  llm: AgentUiLlmStep | null;
  code: AgentUiCodeStep;
  database?: StreamBrowserDatabase;
}) {
  if (database == null || llm == null) {
    return <MetaYamlBlock yamlText={buildRoundMetaYaml(llm, code, null)} />;
  }
  return <RoundMetaWithPrompt llm={llm} code={code} database={database} />;
}

function RoundMetaWithPrompt({
  llm,
  code,
  database,
}: {
  llm: AgentUiLlmStep;
  code: AgentUiCodeStep;
  database: StreamBrowserDatabase;
}) {
  // Prompt construction folds purely from events at or before the request
  // offset — immutable history (the same fold as the ?llmRequest trace sheet,
  // minus the request-scoped lifecycle events that only feed the response
  // side, which this tab doesn't show).
  const eventsResult = useStreamQuery(
    database,
    `SELECT json(raw_jsonb) AS raw_json FROM events
     WHERE type IN (${LLM_REPLAY_EVENT_TYPES.map(() => "?").join(", ")})
       AND offset <= ?
     ORDER BY offset ASC`,
    [...LLM_REPLAY_EVENT_TYPES, llm.llmRequestOffset],
  );
  const loaded = eventsResult.status === "ok";
  const yamlText = useMemo(() => {
    const replay = loaded
      ? replayLlmRequest({
          rawEventJsons: eventsResult.data.map((sqlRow) => String(sqlRow.raw_json)),
          llmRequestOffset: llm.llmRequestOffset,
        })
      : null;
    return buildRoundMetaYaml(llm, code, replay?.messages ?? null);
  }, [loaded, eventsResult.data, llm, code]);
  return <MetaYamlBlock yamlText={yamlText} />;
}

function MetaYamlBlock({ yamlText }: { yamlText: string }) {
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
