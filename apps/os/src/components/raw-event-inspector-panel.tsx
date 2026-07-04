import { useEffect } from "react";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { useStreamQuery } from "~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import { shortEventType } from "~/lib/stream-feed-filters.ts";

/**
 * Raw-event inspection side panel: the full payload of one event from the
 * local SQLite raw-event mirror, pageable through the whole wire log with
 * Prev/Next (or arrow keys) and inter-event timing.
 *
 * Successor to the pre-consolidation `EventsStreamEventInspectorSheet`
 * (packages/ui), rebuilt over the mirror instead of an in-memory event array:
 * adjacency is three live SQL point queries, so paging works across the entire
 * history and the panel updates as new events land. The open offset is
 * URL-backed (`event` in stream-view-search.ts), so any inspected event is a
 * shareable link.
 */
export function RawEventInspectorPanel({
  database,
  offset,
  onNavigate,
  onClose,
}: {
  /** The raw-event mirror (the `events` table), NOT the feed-items database. */
  database: StreamBrowserDatabase;
  offset: number;
  onNavigate: (offset: number) => void;
  onClose: () => void;
}) {
  const selectedResult = useStreamQuery(
    database,
    `SELECT offset, type, created_at, json(raw_jsonb) AS raw_json FROM events WHERE offset = ?`,
    [offset],
  );
  // Adjacency by comparison (not offset ± 1): offsets in the mirror can be
  // sparse, and a stale URL offset still resolves to real neighbours.
  const previousResult = useStreamQuery(
    database,
    `SELECT offset, created_at FROM events WHERE offset < ? ORDER BY offset DESC LIMIT 1`,
    [offset],
  );
  const nextResult = useStreamQuery(
    database,
    `SELECT offset, created_at FROM events WHERE offset > ? ORDER BY offset ASC LIMIT 1`,
    [offset],
  );
  const positionResult = useStreamQuery(
    database,
    `SELECT COUNT(*) AS position, (SELECT COUNT(*) FROM events) AS total FROM events WHERE offset <= ?`,
    [offset],
  );

  const selected = selectedResult.data[0] ?? null;
  const previousOffset = asNumber(previousResult.data[0]?.offset);
  const nextOffset = asNumber(nextResult.data[0]?.offset);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      // The panel coexists with the composer and filter inputs (it is not a
      // modal, unlike the old sheet) — typing there must not page the log.
      if (isTypingTarget(event.target)) return;
      if (event.key === "ArrowLeft" && previousOffset != null) {
        event.preventDefault();
        onNavigate(previousOffset);
      }
      if (event.key === "ArrowRight" && nextOffset != null) {
        event.preventDefault();
        onNavigate(nextOffset);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previousOffset, nextOffset, onNavigate]);

  const selectedTimestamp = parseTimestamp(selected?.created_at);
  const sincePrevious = elapsedBetween(
    parseTimestamp(previousResult.data[0]?.created_at),
    selectedTimestamp,
  );
  const untilNext = elapsedBetween(
    selectedTimestamp,
    parseTimestamp(nextResult.data[0]?.created_at),
  );
  const position = asNumber(positionResult.data[0]?.position);
  const total = asNumber(positionResult.data[0]?.total);

  return (
    <aside
      className="absolute inset-y-0 right-0 z-30 flex w-full max-w-lg flex-col rounded-tl-2xl bg-background shadow-2xl"
      data-testid="raw-event-inspector"
    >
      <div className="flex shrink-0 items-start gap-2 px-5 pb-2 pt-4">
        <div className="min-w-0 flex-1">
          <div
            className="truncate font-mono text-sm font-semibold"
            title={String(selected?.type ?? "")}
          >
            {selected == null ? `Event #${offset}` : shortEventType(String(selected.type))}
          </div>
          <div className="text-xs text-muted-foreground">
            #{offset}
            {position != null && total != null ? ` · event ${position} of ${total}` : null}
            {typeof selected?.created_at === "string" ? ` · ${selected.created_at}` : null}
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
          disabled={previousOffset == null}
          onClick={() => previousOffset != null && onNavigate(previousOffset)}
        >
          <ChevronLeftIcon />
          Prev
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={nextOffset == null}
          onClick={() => nextOffset != null && onNavigate(nextOffset)}
        >
          Next
          <ChevronRightIcon />
        </Button>
        <span className="text-xs text-muted-foreground/70">← → keys page the log</span>
        <span className="ml-auto flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
          {sincePrevious == null ? null : <span title="Since previous event">{sincePrevious}</span>}
          {sincePrevious != null && untilNext != null ? <span>·</span> : null}
          {untilNext == null ? null : <span title="Until next event">{untilNext} to next</span>}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-t px-4 py-3">
        {selectedResult.status === "pending" ? (
          <p className="text-sm text-muted-foreground">Opening local SQLite mirror…</p>
        ) : selected == null ? (
          <p className="text-sm text-muted-foreground">
            Event #{offset} is not in the local mirror (yet). Use Prev/Next to jump to the nearest
            mirrored event.
          </p>
        ) : (
          <SerializedObjectCodeBlock
            data={orderEventKeysForYamlDisplay(parseRawEventJson(String(selected.raw_json)))}
            initialFormat="yaml"
            showToggle
            showCopyButton
          />
        )}
      </div>
    </aside>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" || typeof value === "bigint" ? Number(value) : null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** `+950ms`, `+3.2s`, `+1m40s` — inter-event gap between two mirror timestamps. */
function elapsedBetween(fromMs: number | null, toMs: number | null): string | null {
  if (fromMs == null || toMs == null) return null;
  const ms = Math.max(0, Math.floor(toMs - fromMs));
  if (ms < 1_000) return `+${ms}ms`;
  if (ms < 60_000) {
    const seconds = Math.floor(ms / 100) / 10;
    return `+${seconds.toFixed(1).replace(/\.0$/, "")}s`;
  }
  const totalSeconds = Math.floor(ms / 1_000);
  return `+${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`;
}

const EVENT_YAML_KEY_ORDER = [
  "type",
  "payload",
  "metadata",
  "idempotencyKey",
  "offset",
  "createdAt",
];

/**
 * Stable, signal-first key order (`type`, `payload`, …) for showing a raw
 * event as YAML; `streamPath` is display noise and dropped.
 */
function orderEventKeysForYamlDisplay(event: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of EVENT_YAML_KEY_ORDER) {
    if (key in event) ordered[key] = event[key];
  }
  for (const [key, value] of Object.entries(event)) {
    if (key === "streamPath" || EVENT_YAML_KEY_ORDER.includes(key)) continue;
    ordered[key] = value;
  }
  return ordered;
}

function parseRawEventJson(rawJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    return typeof parsed === "object" && parsed != null
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { raw: rawJson };
  }
}
