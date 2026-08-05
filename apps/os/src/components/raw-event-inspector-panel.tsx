import { useEffect, useEffectEvent, useMemo, useRef } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { SheetDescription, SheetHeader, SheetTitle } from "@iterate-com/ui/components/sheet";
import { useStreamQuery } from "~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import { shortEventType } from "~/lib/stream-feed-filters.ts";

/**
 * Raw-event inspection sheet content: the full payload of one event from the
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
export function RawEventInspectorContent({
  database,
  navigationEnabled,
  offset,
  onNavigate,
}: {
  /** The raw-event mirror (the `events` table), NOT the feed-items database. */
  database: StreamBrowserDatabase;
  /** False while retained solely to paint the parent Sheet's exit transition. */
  navigationEnabled: boolean;
  offset: number;
  onNavigate: (offset: number) => void;
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
  // The durable mirror deliberately omits ephemeral events, so stream
  // offsets can contain permanent gaps and are not row positions. Show the
  // trigger-maintained durable-row total without a COUNT(*) range scan.
  const totalResult = useStreamQuery(
    database,
    `SELECT COALESCE(SUM(n), 0) AS total FROM event_type_counts`,
  );

  const selected = selectedResult.data[0] ?? null;
  const previousOffset = asNumber(previousResult.data[0]?.offset);
  const nextOffset = asNumber(nextResult.data[0]?.offset);

  // The neighbour offsets and navigation callback can change on every render,
  // but the key handler itself should only bind while this content is active.
  // Read neighbours from a ref and the callback through an Effect Event.
  const neighboursRef = useRef({ previousOffset, nextOffset });
  neighboursRef.current = { previousOffset, nextOffset };
  const navigate = useEffectEvent(onNavigate);
  useEffect(() => {
    if (!navigationEnabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      // This listener is window-scoped, so editable controls must keep their
      // arrow keys instead of paging the event log.
      if (isTypingTarget(event.target)) return;
      const { previousOffset, nextOffset } = neighboursRef.current;
      if (event.key === "ArrowLeft" && previousOffset != null) {
        event.preventDefault();
        navigate(previousOffset);
      }
      if (event.key === "ArrowRight" && nextOffset != null) {
        event.preventDefault();
        navigate(nextOffset);
      }
    };
    // Capture phase: Base UI's DialogPopup (our Sheet) stopPropagates composite
    // keys (← → ↑ ↓ Home End) on the popup so nested composites stay isolated.
    // A bubble-only window listener never sees those keydowns while the sheet
    // is open — which is exactly when this inspector is mounted.
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [navigationEnabled]);

  // Parse + reorder only when the underlying row changes, not on every render:
  // a fresh object identity would rebuild CodeMirror (its editor is keyed on
  // the doc value) even when an incidental re-render left the event untouched.
  const selectedRawJson = selected == null ? null : String(selected.raw_json);
  const orderedEventData = useMemo(
    () =>
      selectedRawJson == null
        ? null
        : orderEventKeysForYamlDisplay(parseRawEventJson(selectedRawJson)),
    [selectedRawJson],
  );

  const selectedTimestamp = parseTimestamp(selected?.created_at);
  const sincePrevious = elapsedBetween(
    parseTimestamp(previousResult.data[0]?.created_at),
    selectedTimestamp,
  );
  const untilNext = elapsedBetween(
    selectedTimestamp,
    parseTimestamp(nextResult.data[0]?.created_at),
  );
  const total = asNumber(totalResult.data[0]?.total);

  return (
    <>
      <SheetHeader className="shrink-0 pr-12">
        <SheetTitle className="truncate" title={String(selected?.type ?? "")}>
          {selected == null ? `Event #${offset}` : shortEventType(String(selected.type))}
        </SheetTitle>
        <SheetDescription>
          #{offset}
          {total == null ? null : ` · ${total} mirrored events`}
          {typeof selected?.created_at === "string" ? ` · ${selected.created_at}` : null}
        </SheetDescription>
      </SheetHeader>
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-3">
        <Button
          size="sm"
          variant="outline"
          disabled={!navigationEnabled || previousOffset == null}
          onClick={() => navigationEnabled && previousOffset != null && onNavigate(previousOffset)}
        >
          <ChevronLeftIcon />
          Prev
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!navigationEnabled || nextOffset == null}
          onClick={() => navigationEnabled && nextOffset != null && onNavigate(nextOffset)}
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
        {orderedEventData != null ? (
          // Paging seeds each new query with the prior row while SQLite catches
          // up (stale-while-revalidate), so keep painting the last payload
          // instead of flashing the placeholder — the swap is a clean SQL read.
          <SerializedObjectCodeBlock
            data={orderedEventData}
            initialFormat="yaml"
            showToggle
            showCopyButton
          />
        ) : selectedResult.status === "pending" ? (
          <p className="text-sm text-muted-foreground">Opening local SQLite mirror…</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Event #{offset} is not in the local mirror (yet). Use Prev/Next to jump to the nearest
            mirrored event.
          </p>
        )}
      </div>
    </>
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
