import { memo, useMemo, useState } from "react";
import { CheckIcon, CopyIcon, XIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { toast } from "@iterate-com/ui/components/sonner";
import { MessageResponse } from "@iterate-com/ui/components/ai-elements/message";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { cn } from "@iterate-com/ui/lib/utils";
import { useStreamQuery } from "~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import { formatDateTime, formatSeconds, looksLikeCode } from "~/lib/feed-format.ts";
import {
  LLM_REPLAY_EVENT_TYPES,
  LLM_RESPONSE_CHUNK_EVENT_TYPE,
  replayLlmRequest,
  type LlmRequestReplay,
  type LlmRequestReplayMessage,
  type LlmRequestReplayStats,
} from "~/lib/llm-request-replay.ts";

/**
 * LLM trace side panel: the EXACT request one LLM call sent to the model and
 * the response it made, replayed locally from the raw-event mirror. The
 * processor never stores request bodies — it rebuilds them from committed
 * history per attempt — so this panel runs the same pure fold (see
 * ~/lib/llm-request-replay.ts) over the same events and shows the resulting
 * messages verbatim, including the flattened attachment hint lines. The
 * response side comes from the same journal: the committed output when the
 * turn settled, re-assembled streamed chunks (reasoning included) when it
 * didn't — which also makes an in-flight request's trace grow live as chunk
 * events land. Works retroactively for every request in the journal, at zero
 * storage cost.
 *
 * Fidelity caveat: the request replay is exact as long as the deployed fold
 * semantics match the ones that built the original request — the trade we
 * make for not duplicating every prompt into the journal.
 */
export function LlmRequestInspectorPanel({
  database,
  llmRequestOffset,
  onClose,
}: {
  /** The raw-event mirror (the `events` table), NOT the feed-items database. */
  database: StreamBrowserDatabase;
  /** The llm-request-requested event's offset — the request's identity. */
  llmRequestOffset: number;
  onClose: () => void;
}) {
  // The whole consumed subset, unbounded above: the fold self-filters to
  // offsets ≤ llmRequestOffset, and the request's outcome (completed /
  // cancelled) lands ABOVE it. Bulk emitted-only types (response chunks)
  // stay out of this transfer — the query below fetches only THIS request's.
  const eventsResult = useStreamQuery(
    database,
    `SELECT json(raw_jsonb) AS raw_json FROM events
     WHERE type IN (${LLM_REPLAY_EVENT_TYPES.map(() => "?").join(", ")})
     ORDER BY offset ASC`,
    [...LLM_REPLAY_EVENT_TYPES],
  );
  // This request's streamed chunks: reasoning text lives only here, and for a
  // request that never settled with an output (cancelled / failed / still in
  // flight) the re-assembled deltas are the only copy of the response.
  const chunksResult = useStreamQuery(
    database,
    `SELECT json(raw_jsonb) AS raw_json FROM events
     WHERE type = ? AND json_extract(raw_jsonb, '$.payload.llmRequestOffset') = ?
     ORDER BY offset ASC`,
    [LLM_RESPONSE_CHUNK_EVENT_TYPE, llmRequestOffset],
  );
  // BOTH queries must resolve before replaying: chunks-still-pending is not
  // "no chunks", and for a trace whose only response lives in chunks
  // (cancelled / failed / in flight) rendering early would flash "the model
  // returned no text" over a response that is about to appear.
  const loaded = eventsResult.status === "ok" && chunksResult.status === "ok";
  const replay = useMemo(
    () =>
      loaded
        ? replayLlmRequest({
            rawEventJsons: eventsResult.data.map((sqlRow) => String(sqlRow.raw_json)),
            chunkEventJsons: chunksResult.data.map((sqlRow) => String(sqlRow.raw_json)),
            llmRequestOffset,
          })
        : null,
    [loaded, eventsResult.data, chunksResult.data, llmRequestOffset],
  );

  const [renderMode, setRenderMode] = useState<"markdown" | "plain">("markdown");
  const [copied, setCopied] = useState(false);
  const totalChars = replay?.messages.reduce((sum, message) => sum + message.content.length, 0);

  return (
    <aside
      className="absolute inset-y-0 right-0 z-30 flex w-full flex-col rounded-tl-2xl bg-background shadow-2xl md:w-1/2"
      data-testid="llm-request-inspector"
    >
      <div className="flex shrink-0 items-start gap-2 px-5 pb-2 pt-4">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm font-semibold">
            LLM trace #{llmRequestOffset}
            {replay == null ? "" : ` · ${replay.model}`}
          </div>
          <div className="text-xs text-muted-foreground">
            {replay == null ? (
              "The exact request sent to the model, and its response"
            ) : (
              <>
                {formatDateTime(Date.parse(replay.requestedAt))} ·{" "}
                {replay.messages.length.toLocaleString()} messages ·{" "}
                {(totalChars ?? 0).toLocaleString()} chars
                <OutcomeBadge outcome={replay.outcome} />
              </>
            )}
          </div>
        </div>
        <Button variant="ghost" size="icon" title="Close" onClick={onClose}>
          <XIcon className="size-4" />
        </Button>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pb-3">
        <Button
          size="sm"
          variant="outline"
          aria-pressed={renderMode === "plain"}
          title="Toggle between rendered markdown and the verbatim wire text"
          onClick={() => setRenderMode(renderMode === "markdown" ? "plain" : "markdown")}
        >
          {renderMode === "markdown" ? "Markdown" : "Plain text"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={replay == null}
          title="Copy the request's messages as JSON"
          onClick={async () => {
            if (replay == null) return;
            try {
              // The wire shape only: `id` is this panel's row identity, not
              // part of what the model received.
              const messages = replay.messages.map(({ role, content }) => ({ role, content }));
              await navigator.clipboard.writeText(JSON.stringify({ messages }, null, 2));
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2_000);
            } catch {
              toast.error("Failed to copy to clipboard");
            }
          }}
        >
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          Copy JSON
        </Button>
        <span className="ml-auto text-[10px] text-muted-foreground/70">
          replayed from the local event mirror
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-t">
        {replay != null ? (
          <div className="flex flex-col">
            {replay.messages.map((message) => (
              <ReplayMessageSection key={message.id} message={message} renderMode={renderMode} />
            ))}
            <ReplayResponseSection replay={replay} renderMode={renderMode} />
            <ReplayMetricsSection stats={replay.stats} />
          </div>
        ) : eventsResult.status === "error" || chunksResult.status === "error" ? (
          // An errored query never resolves on its own — say so instead of
          // presenting a permanent "opening" state as progress.
          <p className="px-5 py-3 text-sm text-destructive">
            Reading the local event mirror failed:{" "}
            {(eventsResult.error ?? chunksResult.error)?.message ?? "unknown error"}
          </p>
        ) : !loaded ? (
          <p className="px-5 py-3 text-sm text-muted-foreground">Opening local SQLite mirror…</p>
        ) : (
          <p className="px-5 py-3 text-sm text-muted-foreground">
            No LLM request at offset #{llmRequestOffset} in the local mirror (yet). If this stream
            is still syncing, the request will appear once its events arrive.
          </p>
        )}
      </div>
    </aside>
  );
}

function OutcomeBadge({ outcome }: { outcome: LlmRequestReplay["outcome"] }) {
  if (outcome == null) return <> · in flight</>;
  const duration = outcome.durationMs == null ? "" : ` in ${formatSeconds(outcome.durationMs)}`;
  return (
    <>
      {" · "}
      <span
        className={cn(
          outcome.status === "success" && "text-emerald-600 dark:text-emerald-500",
          outcome.status === "failure" && "text-destructive",
          outcome.status === "cancelled" && "text-amber-600 dark:text-amber-500",
        )}
        title={outcome.errorMessage ?? undefined}
      >
        {outcome.status}
        {duration}
      </span>
    </>
  );
}

// Memoized on (message, renderMode): the mirror query re-resolves whenever the
// stream appends a consumed event, but a settled request's messages are
// value-identical across resolves — re-rendering the markdown for a long
// transcript on every append would burn main-thread time for nothing.
// `message` objects are rebuilt per resolve, so compare by content value.
const ReplayMessageSection = memo(
  function ReplayMessageSection({
    message,
    renderMode,
  }: {
    message: LlmRequestReplayMessage;
    renderMode: "markdown" | "plain";
  }) {
    return (
      <section className="border-b border-border/60 px-5 py-3">
        <div className="mb-2 flex items-baseline gap-2">
          <span
            className={cn(
              "font-mono text-[10px] font-semibold uppercase tracking-wider",
              message.role === "system" && "text-purple-700 dark:text-purple-300",
              message.role === "user" && "text-blue-700 dark:text-blue-300",
              message.role === "assistant" && "text-emerald-700 dark:text-emerald-400",
            )}
          >
            {message.role}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground/60">
            {message.content.length.toLocaleString()} chars
          </span>
        </div>
        {renderMode === "markdown" ? (
          // Settled text never streams; static mode renders synchronously and
          // skips streaming markdown's unpaired-marker balancing (see the
          // agent feed's settled rows for the full story).
          <MessageResponse
            className="min-w-0 max-w-full overflow-hidden text-sm"
            mode="static"
            parseIncompleteMarkdown={false}
          >
            {message.content}
          </MessageResponse>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
            {message.content}
          </pre>
        )}
      </section>
    );
  },
  (previous, next) =>
    previous.renderMode === next.renderMode &&
    previous.message.id === next.message.id &&
    previous.message.content === next.message.content,
);

/**
 * The trace's response half: reasoning ("thinking") first when the model
 * streamed any, then the response text — as a code block when it's a codemode
 * script (matching the feed's treatment), else through the markdown/plain
 * toggle. A failed request shows its error here too; the "(partial…)" label
 * marks chunk-reassembled text that never settled into a committed output.
 */
const ReplayResponseSection = memo(
  function ReplayResponseSection({
    replay,
    renderMode,
  }: {
    replay: LlmRequestReplay;
    renderMode: "markdown" | "plain";
  }) {
    const { response, outcome } = replay;
    return (
      <section className="border-b border-border/60 bg-muted/20 px-5 py-3">
        <div className="mb-2 flex items-baseline gap-2">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
            response
          </span>
          {response == null ? null : (
            <span className="font-mono text-[10px] text-muted-foreground/60">
              {response.text.length.toLocaleString()} chars
              {response.source === "chunks" && outcome != null
                ? " · partial (re-assembled from streamed chunks)"
                : response.source === "chunks"
                  ? " · streaming"
                  : ""}
            </span>
          )}
        </div>
        {response == null || response.thinkingText === "" ? null : (
          <div className="mb-2 max-w-full whitespace-pre-wrap rounded-xl bg-muted/50 px-4 py-3 text-sm italic leading-relaxed text-muted-foreground">
            {response.thinkingText}
          </div>
        )}
        {response == null || response.text === "" ? null : looksLikeCode(response.text) ? (
          <SourceCodeBlock
            code={response.text}
            language="typescript"
            className="max-h-96"
            showCopyButton
            showLineNumbers={false}
            plainChrome
          />
        ) : renderMode === "markdown" ? (
          <MessageResponse
            className="min-w-0 max-w-full overflow-hidden text-sm"
            mode="static"
            parseIncompleteMarkdown={false}
          >
            {response.text}
          </MessageResponse>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
            {response.text}
          </pre>
        )}
        {outcome?.errorMessage == null ? null : (
          <pre className="mt-2 overflow-x-auto rounded-xl bg-destructive/5 px-4 py-2.5 font-mono text-xs leading-relaxed text-destructive">
            {outcome.errorMessage}
          </pre>
        )}
        {response == null && outcome?.errorMessage == null ? (
          <p className="text-sm text-muted-foreground">
            {outcome == null
              ? "Nothing has streamed back yet."
              : "The model returned no text for this request."}
          </p>
        ) : null}
      </section>
    );
  },
  (previous, next) =>
    previous.renderMode === next.renderMode &&
    previous.replay.response?.text === next.replay.response?.text &&
    previous.replay.response?.thinkingText === next.replay.response?.thinkingText &&
    previous.replay.response?.source === next.replay.response?.source &&
    previous.replay.outcome?.status === next.replay.outcome?.status &&
    previous.replay.outcome?.errorMessage === next.replay.outcome?.errorMessage,
);

/**
 * Everything else the journal recorded about the call: normalized token
 * counts with context-window fullness, latency split into time-to-first-chunk
 * (the dial → the first streamed token landing) and the generation window
 * (with a derived tokens/second), and the transport's verbatim completion
 * payload behind a disclosure. All timings come from the lifecycle events'
 * own server-stamped append times.
 */
function ReplayMetricsSection({ stats }: { stats: LlmRequestReplayStats }) {
  const { tokens } = stats;
  const hasAnything =
    tokens != null ||
    stats.chunkCount > 0 ||
    stats.generationMs != null ||
    stats.rawResponse != null;
  if (!hasAnything) return null;
  const contextPercent =
    tokens == null
      ? null
      : Math.round(((tokens.inputTokens + tokens.outputTokens) / tokens.maxContextTokens) * 1000) /
        10;
  const streamingParts = [
    stats.timeToFirstChunkMs == null
      ? null
      : `first chunk after ${formatSeconds(stats.timeToFirstChunkMs)}`,
    stats.generationMs == null ? null : `generated in ${formatSeconds(stats.generationMs)}`,
    stats.chunkCount === 0 ? null : `${stats.chunkCount.toLocaleString()} chunks`,
    stats.outputTokensPerSecond == null ? null : `${stats.outputTokensPerSecond} tok/s`,
  ].filter((part) => part != null);
  return (
    <section className="px-5 py-3">
      <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        metrics
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs text-foreground/80">
        {tokens == null ? null : (
          <>
            <dt className="text-muted-foreground/70">input</dt>
            <dd>
              {tokens.inputTokens.toLocaleString()} tok
              {tokens.cachedInputTokens == null || tokens.cachedInputTokens === 0
                ? ""
                : ` (${tokens.cachedInputTokens.toLocaleString()} cached)`}
            </dd>
            <dt className="text-muted-foreground/70">output</dt>
            <dd>
              {tokens.outputTokens.toLocaleString()} tok
              {tokens.reasoningOutputTokens == null || tokens.reasoningOutputTokens === 0
                ? ""
                : ` (${tokens.reasoningOutputTokens.toLocaleString()} reasoning)`}
            </dd>
            <dt className="text-muted-foreground/70">context</dt>
            <dd>
              {contextPercent}% of {Math.round(tokens.maxContextTokens / 1000)}k window
            </dd>
          </>
        )}
        {streamingParts.length === 0 ? null : (
          <>
            <dt className="text-muted-foreground/70">streaming</dt>
            <dd>{streamingParts.join(" · ")}</dd>
          </>
        )}
      </dl>
      {stats.rawResponse == null ? null : (
        <details className="mt-2">
          <summary className="cursor-pointer font-mono text-xs text-muted-foreground/70 hover:text-foreground">
            raw completion payload
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-xl bg-muted/50 px-4 py-2.5 font-mono text-xs leading-relaxed text-muted-foreground">
            {stringifyRawResponse(stats.rawResponse)}
          </pre>
        </details>
      )}
    </section>
  );
}

function stringifyRawResponse(rawResponse: unknown): string {
  try {
    return JSON.stringify(rawResponse, null, 2) ?? String(rawResponse);
  } catch {
    return String(rawResponse);
  }
}
