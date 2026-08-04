import { useMemo, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type {
  AgentUiActivityRound,
  AgentUiCodeStep,
  AgentUiLlmStep,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { Button } from "@iterate-com/ui/components/button";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { cn } from "@iterate-com/ui/lib/utils";
import { useStreamQuery } from "~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import { buildRoundMetaYaml } from "~/lib/agent-round-meta-yaml.ts";
import { formatClockTime, formatSeconds, formatTokens, looksLikeCode } from "~/lib/feed-format.ts";
import { LLM_REPLAY_EVENT_TYPES, replayLlmRequest } from "~/lib/llm-request-replay.ts";
import {
  MAX_HIGHLIGHTED_SCRIPT_RESULT_CHARACTERS,
  oversizedScriptResultPreview,
} from "~/lib/script-result-preview.ts";

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
// other should follow.

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
          "-ml-2 self-start font-normal",
          failed && "text-destructive hover:text-destructive",
        )}
      >
        <span className={cn("font-mono text-xs text-foreground/70", failed && "text-destructive")}>
          Round {index + 1}
        </span>
        <span className="font-mono text-xs text-muted-foreground/70">{roundHeaderMeta(round)}</span>
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
 * A round with no code step: a request that was cancelled, failed, or whose
 * code half never arrived. No tab bar (mirroring mobile's LlmStepView) — the
 * stat line renders in place, with the partial response/thinking below and
 * the full trace sheet one click away.
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
      <Button
        variant="ghost"
        size="xs"
        title="Open this LLM request trace"
        data-testid="agent-feed-inspect-llm-request"
        disabled={onInspectLlmRequest == null}
        onClick={() => onInspectLlmRequest?.(llm.llmRequestOffset)}
        className="-ml-2 self-start font-normal disabled:opacity-100"
      >
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
          <ChevronRightIcon data-icon="inline-end" className="text-muted-foreground/50" />
        )}
      </Button>
      {llm.thinkingText === "" ? null : (
        <div className="max-w-2xl whitespace-pre-wrap px-1.5 text-sm italic leading-relaxed text-muted-foreground">
          {llm.thinkingText}
        </div>
      )}
      {llm.responseText === "" ? null : looksLikeCode(llm.responseText) ? (
        <div className="w-full max-w-2xl">
          <SourceCodeBlock code={llm.responseText} language="typescript" showLineNumbers={false} />
        </div>
      ) : (
        <div className="max-w-2xl whitespace-pre-wrap px-1.5 text-sm leading-relaxed">
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

/**
 * One code round as tabs. Script is always there; Result only once the run
 * settled with a value or an error; Meta always trails with the round's stats
 * and replayed prompt. (Mobile renders an Approvals tab between Script and
 * Result — the web feed has no approval events wired in yet, so that slot is
 * intentionally empty here.) Tab choice falls back to Script whenever the
 * chosen tab isn't offered.
 */
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
        <RoundResult code={code} />
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

function RoundResult({ code }: { code: AgentUiCodeStep }) {
  const oversizedResult = useMemo(
    () => (code.result === undefined ? null : oversizedScriptResultPreview(code.result)),
    [code.result],
  );
  return (
    <>
      {code.errorMessage == null ? null : (
        <pre className="whitespace-pre-wrap rounded-lg bg-destructive/5 px-3 py-2 font-mono text-xs leading-relaxed text-destructive">
          {code.errorMessage}
        </pre>
      )}
      {code.result === undefined ? null : oversizedResult == null ? (
        <div className="max-h-80 overflow-y-auto">
          <SerializedObjectCodeBlock
            data={code.result}
            initialFormat="json"
            showToggle
            showCopyButton
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-muted/20">
          <p className="border-b px-3 py-2 text-xs text-muted-foreground">
            This result is {oversizedResult.totalCharacters.toLocaleString()} characters. Showing
            the first {MAX_HIGHLIGHTED_SCRIPT_RESULT_CHARACTERS / 1024} KB without syntax
            highlighting.
          </p>
          <pre
            className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed"
            data-testid="script-result-bounded-preview"
          >
            {oversizedResult.preview}
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
      <SourceCodeBlock code={yamlText} language="yaml" showLineNumbers={false} />
    </div>
  );
}

/**
 * The "Round N" header's muted suffix — the at-a-glance facts the old flat
 * step rail used to spend two rows on.
 */
function roundHeaderMeta(round: AgentUiActivityRound): string {
  const { code, llm } = round;
  if (code != null) {
    const parts = [
      ...(code.status === "running"
        ? ["Running code"]
        : code.success === false
          ? ["Code failed"]
          : []),
      `Started ${formatClockTime(code.startedAtMs)}`,
      ...(code.durationMs == null ? [] : [formatSeconds(code.durationMs)]),
      ...(llm?.outcome === "failed" ? ["request failed"] : []),
    ];
    return parts.join(" · ");
  }
  if (llm == null) return "";
  return [llmStepLabel(llm), llmStepMeta(llm)].filter((part) => part !== "").join(" · ");
}

function llmStepLabel(llm: AgentUiLlmStep): string {
  if (llm.cancelReason === "interrupted-by-user-input") return "Stopped for your new message";
  if (llm.cancelReason === "expired") return "Request expired";
  if (llm.outcome === "cancelled") return "Request cancelled";
  return llm.model ?? "LLM request";
}

function llmStepMeta(llm: AgentUiLlmStep): string {
  const parts: string[] = [];
  if (llm.cancelReason != null && llm.model != null) parts.push(llm.model);
  if (llm.inputTokens != null || llm.outputTokens != null) {
    parts.push(`${formatTokens(llm.inputTokens)} → ${formatTokens(llm.outputTokens)} tok`);
  }
  if (llm.durationMs != null) parts.push(formatSeconds(llm.durationMs));
  if (llm.outcome === "failed") parts.push("failed");
  return parts.join(" · ");
}
