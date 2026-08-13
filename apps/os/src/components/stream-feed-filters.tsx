import { useCallback, useMemo, useState } from "react";
import { ChevronDownIcon, SearchIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { cn } from "@iterate-com/ui/lib/utils";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import { useStreamQuery } from "~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts";
import { FEED_TYPE_EXPRESSION, shortComponent, shortEventType } from "~/lib/stream-feed-filters.ts";
import {
  modeCapabilities,
  streamViewMode,
  useStreamViewSearch,
  type StreamViewMode,
} from "~/lib/stream-view-search.ts";

/**
 * Mode-owned filter row + expandable type filter panel.
 *
 * Pretty = search only. Pretty+raw and Raw add the "Types" expander narrowing
 * the raw rows of the one interleaved feed, with two sections:
 *   1) Raw feed item kinds (`components` — feed_items.kind, raw.* family)
 *   2) Raw event types (`types`)
 */
export function StreamFeedFilterRow({
  eventCount,
  connectionStatus,
  feedDatabase,
  streamPath,
}: {
  eventCount: number;
  connectionStatus: string;
  feedDatabase: StreamBrowserDatabase;
  streamPath: string;
}) {
  const { search, setSearch } = useStreamViewSearch();
  const mode = streamViewMode(search, streamPath);
  const caps = modeCapabilities(search, streamPath);
  const focusOnMount = useCallback((element: HTMLInputElement | null) => element?.focus(), []);
  const [typesOpen, setTypesOpen] = useState(false);
  const showTypePanel = caps.rawComponents || caps.rawEventTypes;
  const typeFilterCount = (search.components?.length ?? 0) + (search.types?.length ?? 0);
  const searchLabel = caps.agentFeed
    ? caps.rawFeed
      ? "Search pretty feed"
      : "Search chat"
    : "Search feed";

  return (
    <div className="flex shrink-0 flex-col gap-2 px-4 pb-1.5 pt-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {caps.search ? (
          <div className="flex h-8 min-w-0 max-w-xs flex-1 items-center gap-2 rounded-full bg-muted px-3">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={focusOnMount}
              value={search.q ?? ""}
              onChange={(event) => setSearch({ q: event.target.value || undefined })}
              placeholder={`${searchLabel}…`}
              aria-label={searchLabel}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        ) : null}
        {showTypePanel ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={typesOpen}
            data-testid="stream-feed-types-toggle"
            onClick={() => setTypesOpen((open) => !open)}
            className="relative font-mono text-xs font-normal"
          >
            Types
            {typeFilterCount > 0 ? (
              <span className="ml-1.5 rounded-full bg-primary px-1.5 py-px text-[10px] text-primary-foreground">
                {typeFilterCount}
              </span>
            ) : null}
            <ChevronDownIcon
              className={cn(
                "size-3.5 text-muted-foreground transition-transform",
                typesOpen && "rotate-180",
              )}
            />
          </Button>
        ) : null}
        {caps.rawOffsets ? (
          <div
            className="flex items-center gap-1 font-mono text-xs text-muted-foreground"
            title="Raw event offset range"
          >
            <span>from</span>
            <OffsetInput
              value={search.from}
              placeholder="#"
              onChange={(from) => setSearch({ from })}
            />
            <span>to</span>
            <OffsetInput value={search.to} placeholder="#" onChange={(to) => setSearch({ to })} />
          </div>
        ) : null}
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {eventCount.toLocaleString()} events · {connectionStatus}
          {modeLabel(mode)}
        </span>
      </div>

      {showTypePanel && typesOpen ? (
        <TypeFilterPanel
          database={feedDatabase}
          components={search.components ?? null}
          eventTypes={search.types ?? null}
          onComponentsChange={(components) => setSearch({ components: components ?? undefined })}
          onEventTypesChange={(types) => setSearch({ types: types ?? undefined })}
        />
      ) : null}
    </div>
  );
}

function TypeFilterPanel({
  database,
  components,
  eventTypes,
  onComponentsChange,
  onEventTypesChange,
}: {
  database: StreamBrowserDatabase;
  components: readonly string[] | null;
  eventTypes: readonly string[] | null;
  onComponentsChange: (components: string[] | null) => void;
  onEventTypesChange: (eventTypes: string[] | null) => void;
}) {
  const componentOptions = useComponentOptions(database);
  const eventTypeOptions = useEventTypeOptions(database);

  return (
    <div className="rounded-xl border bg-muted/20 p-3" data-testid="stream-feed-types-panel">
      <div className="grid gap-4 lg:grid-cols-2">
        <TypeSection
          title="Feed item types"
          description="Shape of each raw feed row (group, stream.woken, child stream, …)."
          emptyLabel="No feed item types in the mirror yet."
          options={componentOptions}
          shortLabel={shortComponent}
          value={components}
          onChange={onComponentsChange}
          dataTestId="stream-feed-components-grid"
        />
        <div className="flex min-h-0 flex-col gap-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-foreground">Raw event types</div>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              Primary event type inside a feed item (group eventType or singleton).
            </p>
          </div>
          <TypeCheckboxGrid
            emptyLabel="No event types in the mirror yet."
            options={eventTypeOptions}
            shortLabel={shortEventType}
            value={eventTypes}
            onChange={onEventTypesChange}
            dataTestId="stream-feed-event-types-grid"
          />
        </div>
      </div>
    </div>
  );
}

function TypeSection({
  title,
  description,
  emptyLabel,
  options,
  shortLabel,
  value,
  onChange,
  dataTestId,
}: {
  title: string;
  description: string;
  emptyLabel: string;
  options: readonly { count: number; type: string }[];
  shortLabel: (type: string) => string;
  value: readonly string[] | null;
  onChange: (next: string[] | null) => void;
  dataTestId: string;
}) {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div>
        <div className="text-xs font-semibold text-foreground">{title}</div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{description}</p>
      </div>
      <TypeCheckboxGrid
        emptyLabel={emptyLabel}
        options={options}
        shortLabel={shortLabel}
        value={value}
        onChange={onChange}
        dataTestId={dataTestId}
      />
    </div>
  );
}

function TypeCheckboxGrid({
  emptyLabel,
  options,
  shortLabel,
  value,
  onChange,
  dataTestId,
}: {
  emptyLabel: string;
  options: readonly { count: number; type: string }[];
  shortLabel: (type: string) => string;
  value: readonly string[] | null;
  onChange: (next: string[] | null) => void;
  dataTestId: string;
}) {
  const selected = value ?? EMPTY_SELECTION;
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const merged = useMemo(() => {
    const optionTypes = new Set(options.map((entry) => entry.type));
    const staleSelections = selected.filter((type) => !optionTypes.has(type));
    return [...staleSelections.map((type) => ({ count: 0, type })), ...options].sort((a, b) =>
      shortLabel(a.type).localeCompare(shortLabel(b.type)),
    );
  }, [options, shortLabel, selected]);

  function toggle(type: string, checked: boolean) {
    const current = value ?? EMPTY_SELECTION;
    const next = checked ? [...current, type] : current.filter((entry) => entry !== type);
    onChange(!next.length ? null : next);
  }

  return (
    <div className="flex min-h-0 flex-col gap-1.5" data-testid={dataTestId}>
      <div className="max-h-52 overflow-y-auto rounded-lg border bg-background p-1.5">
        {!merged.length ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">{emptyLabel}</p>
        ) : (
          <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
            {merged.map((entry) => {
              const checked = selectedSet.has(entry.type);
              return (
                <label
                  key={entry.type}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/60",
                    checked && "bg-muted/50",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => toggle(entry.type, event.target.checked)}
                    className="size-3.5 shrink-0 rounded border-border"
                  />
                  <span
                    className="min-w-0 flex-1 truncate font-mono"
                    title={shortLabel(entry.type)}
                  >
                    {shortLabel(entry.type)}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {entry.count.toLocaleString()}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>
      {selected.length ? (
        <button
          type="button"
          className="self-start text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => onChange(null)}
        >
          Clear selection ({selected.length})
        </button>
      ) : null}
    </div>
  );
}

function useComponentOptions(database: StreamBrowserDatabase) {
  // Only the raw.* kind family is filterable here — agent rows are governed
  // by the mode, not the type panel.
  const result = useStreamQuery(
    database,
    `SELECT kind, COUNT(*) AS total FROM feed_items WHERE kind LIKE 'raw.%'
     GROUP BY kind ORDER BY kind`,
    [],
  );
  return result.data.flatMap((row) =>
    typeof row.kind === "string" ? [{ count: Number(row.total ?? 0), type: row.kind }] : [],
  );
}

function useEventTypeOptions(database: StreamBrowserDatabase) {
  const result = useStreamQuery(
    database,
    `SELECT ${FEED_TYPE_EXPRESSION} AS event_type, SUM(event_count) AS total
     FROM feed_items WHERE kind LIKE 'raw.%'
     GROUP BY event_type ORDER BY event_type`,
    [],
  );
  return result.data.flatMap((row) =>
    typeof row.event_type === "string"
      ? [{ count: Number(row.total ?? 0), type: row.event_type }]
      : [],
  );
}

const EMPTY_SELECTION: readonly string[] = [];

function modeLabel(mode: StreamViewMode): string {
  if (mode === "pretty") return " · pretty";
  if (mode === "pretty-raw") return " · pretty+raw";
  return " · raw";
}

function OffsetInput({
  value,
  placeholder,
  onChange,
}: {
  value: number | undefined;
  placeholder: string;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <input
      inputMode="numeric"
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(event) => {
        const raw = event.target.value.trim();
        if (raw === "") {
          onChange(undefined);
          return;
        }
        const parsed = Number(raw);
        // Offsets are non-negative; clamp so hand-typed negatives can't empty the feed.
        if (Number.isFinite(parsed)) onChange(Math.max(0, Math.trunc(parsed)));
      }}
      className="w-14 rounded-md border border-border bg-background px-1.5 py-0.5 text-center outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}
