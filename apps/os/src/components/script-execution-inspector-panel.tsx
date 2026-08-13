import { useMemo, useState } from "react";
import { SheetDescription, SheetHeader, SheetTitle } from "@iterate-com/ui/components/sheet";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { cn } from "@iterate-com/ui/lib/utils";
import { useStreamQuery } from "~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import { formatDateTime, formatSeconds } from "~/lib/feed-format.ts";
import {
  MAX_HIGHLIGHTED_SCRIPT_RESULT_CHARACTERS,
  oversizedScriptResultPreview,
} from "~/lib/script-result-preview.ts";
import {
  replayScriptExecution,
  SCRIPT_EXECUTION_COMPLETED_EVENT_TYPE,
  SCRIPT_EXECUTION_REPLAY_EVENT_TYPES,
  SCRIPT_EXECUTION_REQUESTED_EVENT_TYPE,
  type ScriptExecutionReplay,
} from "~/lib/script-execution-replay.ts";
import { useTickingNowMs } from "~/lib/use-ticking-now-ms.ts";

/**
 * Script trace sheet content: the exact submitted source and its durable outcome,
 * reconstructed from the raw mirror. The execution id is URL-backed by the
 * parent stream view, so every code row has a stable shareable destination.
 */
export function ScriptExecutionInspectorContent({
  database,
  executionId,
}: {
  database: StreamBrowserDatabase;
  executionId: string;
}) {
  const eventsResult = useStreamQuery(
    database,
    `SELECT type, json(raw_jsonb) AS raw_json FROM events
     WHERE type IN (${SCRIPT_EXECUTION_REPLAY_EVENT_TYPES.map(() => "?").join(", ")})
       AND json_extract(raw_jsonb, '$.payload.executionId') = ?
     ORDER BY offset ASC`,
    [...SCRIPT_EXECUTION_REPLAY_EVENT_TYPES, executionId],
  );
  const lifecycleIsIncomplete =
    eventsResult.status === "ok" &&
    eventsResult.data.some((row) => row.type === SCRIPT_EXECUTION_REQUESTED_EVENT_TYPE) &&
    !eventsResult.data.some((row) => row.type === SCRIPT_EXECUTION_COMPLETED_EVENT_TYPE);
  const deadlineMs = useMemo(
    () =>
      eventsResult.status === "ok"
        ? (replayScriptExecution({
            executionId,
            nowMs: 0,
            rawEventJsons: eventsResult.data.map((row) => String(row.raw_json)),
          })?.expiresAtMs ?? null)
        : null,
    [eventsResult.data, eventsResult.status, executionId],
  );
  const nowMs = useTickingNowMs(1_000, lifecycleIsIncomplete, deadlineMs);
  const replay = useMemo(
    () =>
      eventsResult.status === "ok"
        ? replayScriptExecution({
            executionId,
            nowMs,
            rawEventJsons: eventsResult.data.map((row) => String(row.raw_json)),
          })
        : null,
    [eventsResult.data, eventsResult.status, executionId, nowMs],
  );
  const [tab, setTab] = useState<"code" | "result">("code");

  return (
    <>
      <SheetHeader className="shrink-0 pr-12">
        <SheetTitle className="truncate" title={executionId}>
          Code execution · {executionId}
        </SheetTitle>
        <SheetDescription className="flex flex-wrap items-center gap-x-1">
          {replay ? (
            <>
              <span>{formatDateTime(Date.parse(replay.requestedAt))}</span>
              <span aria-hidden="true">·</span>
              <ScriptOutcomeSummary replay={replay} />
              <span title={`Absolute deadline: ${formatDateTime(replay.expiresAtMs)}`}>
                · deadline {formatDateTime(replay.expiresAtMs)}
              </span>
            </>
          ) : (
            "Submitted code and its result"
          )}
        </SheetDescription>
      </SheetHeader>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value === "result" ? "result" : "code")}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="shrink-0 border-b px-5 pb-3">
          <TabsList>
            <TabsTrigger value="code">Code</TabsTrigger>
            <TabsTrigger value="result">Result</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="code" className="min-h-0 overflow-y-auto p-4">
          {replay ? (
            <SourceCodeBlock
              code={replay.code}
              language="typescript"
              className="min-h-full"
              showCopyButton
            />
          ) : (
            <InspectorState result={eventsResult} empty={`No submitted code for ${executionId}.`} />
          )}
        </TabsContent>
        <TabsContent value="result" className="min-h-0 overflow-y-auto p-4">
          {replay ? (
            <ScriptResult replay={replay} />
          ) : (
            <InspectorState
              result={eventsResult}
              empty={`No script execution named ${executionId} is in the local mirror yet.`}
            />
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}

function ScriptOutcomeSummary({ replay }: { replay: ScriptExecutionReplay }) {
  const { outcome } = replay;
  return (
    <span
      className={cn(
        outcome.status === "completed" && "text-emerald-600 dark:text-emerald-500",
        outcome.status === "failed" && "text-destructive",
        (outcome.status === "queued" || outcome.status === "running") &&
          "text-amber-600 dark:text-amber-500",
      )}
      title={outcome.errorMessage ?? undefined}
      data-testid="script-execution-outcome"
    >
      {outcome.status}
      {Number.isFinite(outcome.durationMs)
        ? ` ${outcome.status === "queued" || outcome.status === "running" ? "for" : "in"} ${formatSeconds(outcome.durationMs)}`
        : ""}
    </span>
  );
}

function ScriptResult({ replay }: { replay: ScriptExecutionReplay }) {
  const { outcome } = replay;
  const failure = outcome.settlement?.status === "failed" ? outcome.settlement : null;
  const oversizedResult = useMemo(
    () => (outcome.hasResult ? oversizedScriptResultPreview(outcome.result) : null),
    [outcome.hasResult, outcome.result],
  );
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-xl bg-muted/40 px-4 py-3 font-mono text-xs">
        <dt className="text-muted-foreground">status</dt>
        <dd>{outcome.status}</dd>
        <dt className="text-muted-foreground">duration</dt>
        <dd>
          {Number.isFinite(outcome.durationMs) ? formatSeconds(outcome.durationMs) : "not finished"}
        </dd>
        <dt className="text-muted-foreground">started</dt>
        <dd>{replay.startedAt ? formatDateTime(Date.parse(replay.startedAt)) : "not recorded"}</dd>
        <dt className="text-muted-foreground">completed</dt>
        <dd>
          {replay.completedAt
            ? formatDateTime(Date.parse(replay.completedAt))
            : outcome.status === "queued" || outcome.status === "running"
              ? "not yet"
              : "not recorded"}
        </dd>
        <dt className="text-muted-foreground">settlement</dt>
        <dd>{outcome.settlement ? "durable" : "not recorded"}</dd>
        {failure ? (
          <>
            <dt className="text-muted-foreground">failure kind</dt>
            <dd>{failure.failureKind}</dd>
            <dt className="text-muted-foreground">phase</dt>
            <dd>{failure.phase}</dd>
            <dt className="text-muted-foreground">execution may have occurred</dt>
            <dd>{failure.executionMayHaveOccurred ? "yes" : "no"}</dd>
            <dt className="text-muted-foreground">cancellation</dt>
            <dd>{failure.cancellation}</dd>
          </>
        ) : null}
      </dl>

      {outcome.errorMessage ? (
        <section>
          <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-destructive">
            error
          </h3>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl bg-destructive/5 px-4 py-3 font-mono text-xs leading-relaxed text-destructive">
            {outcome.errorMessage}
          </pre>
        </section>
      ) : null}

      {outcome.hasResult ? (
        <section>
          <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            returned value
          </h3>
          {oversizedResult ? (
            <div className="overflow-hidden rounded-xl border bg-muted/20">
              <p className="border-b px-4 py-3 text-xs text-muted-foreground">
                This result is {oversizedResult.totalCharacters.toLocaleString()} characters.
                Showing the first {MAX_HIGHLIGHTED_SCRIPT_RESULT_CHARACTERS / 1024} KB without
                syntax highlighting.
              </p>
              <pre
                className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed"
                data-testid="script-result-bounded-preview"
              >
                {oversizedResult.preview}
                {"\n…"}
              </pre>
            </div>
          ) : (
            <SerializedObjectCodeBlock
              data={outcome.result}
              initialFormat="json"
              showToggle
              showCopyButton
            />
          )}
        </section>
      ) : outcome.status === "completed" ? (
        <p className="text-sm text-muted-foreground">
          The script completed without a returned value.
        </p>
      ) : null}
    </div>
  );
}

function InspectorState({
  result,
  empty,
}: {
  result: ReturnType<typeof useStreamQuery>;
  empty: string;
}) {
  if (result.status === "error") {
    return (
      <p className="text-sm text-destructive">
        Reading the local event mirror failed: {result.error?.message ?? "unknown error"}
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      {result.status === "pending" ? "Opening local SQLite mirror…" : empty}
    </p>
  );
}
