import { memo, useMemo, useState } from "react";
import { CheckIcon, CopyIcon, XIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { MessageResponse } from "@iterate-com/ui/components/ai-elements/message";
import { cn } from "@iterate-com/ui/lib/utils";
import { useStreamQuery } from "~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import {
  LLM_REPLAY_EVENT_TYPES,
  replayLlmRequest,
  type LlmRequestReplayMessage,
} from "~/lib/llm-request-replay.ts";

/**
 * LLM-request inspection side panel: the EXACT context one request sent to
 * the model, replayed locally from the raw-event mirror. The processor never
 * stores request bodies — it rebuilds them from committed history per attempt
 * — so this panel runs the same pure fold (see ~/lib/llm-request-replay.ts)
 * over the same events and shows the resulting messages verbatim, including
 * the flattened attachment hint lines. Works retroactively for every request
 * in the journal, at zero storage cost.
 *
 * Fidelity caveat: the replay is exact as long as the deployed fold semantics
 * match the ones that built the original request — the trade we make for not
 * duplicating every prompt into the journal.
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
  // never leave SQLite.
  const eventsResult = useStreamQuery(
    database,
    `SELECT json(raw_jsonb) AS raw_json FROM events
     WHERE type IN (${LLM_REPLAY_EVENT_TYPES.map(() => "?").join(", ")})
     ORDER BY offset ASC`,
    [...LLM_REPLAY_EVENT_TYPES],
  );
  const replay = useMemo(
    () =>
      eventsResult.status === "ok"
        ? replayLlmRequest({
            rawEventJsons: eventsResult.data.map((sqlRow) => String(sqlRow.raw_json)),
            llmRequestOffset,
          })
        : null,
    [eventsResult.status, eventsResult.data, llmRequestOffset],
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
            LLM request #{llmRequestOffset}
            {replay == null ? "" : ` · ${replay.model}`}
          </div>
          <div className="text-xs text-muted-foreground">
            {replay == null ? (
              "The exact context sent to the model"
            ) : (
              <>
                {new Date(replay.requestedAt).toLocaleString()} ·{" "}
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
            await navigator.clipboard.writeText(
              JSON.stringify({ messages: replay.messages }, null, 2),
            );
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
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
            {replay.messages.map((message, index) => (
              <ReplayMessageSection
                // Positional identity is stable: the replayed request is an
                // immutable fact of the journal, so index-keyed rows never
                // reorder under the same offset.
                key={index}
                message={message}
                renderMode={renderMode}
              />
            ))}
          </div>
        ) : eventsResult.status === "pending" ? (
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

function OutcomeBadge({
  outcome,
}: {
  outcome: NonNullable<ReturnType<typeof replayLlmRequest>>["outcome"];
}) {
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
    previous.message.role === next.message.role &&
    previous.message.content === next.message.content,
);

function formatSeconds(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1).replace(/\.0$/, "")} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}
