import { useCallback } from "react";
import { SearchIcon } from "lucide-react";
import { cn } from "@iterate-com/ui/lib/utils";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import { FeedEventTypesFilter } from "~/components/feed-items-view.tsx";
import type { StreamFeedPreset } from "~/lib/stream-feed-filters.ts";
import { useStreamViewSearch } from "~/lib/stream-view-search.ts";

/**
 * The Feed tab's filter row: preset pills, text search, any-of event types,
 * and raw-offset bounds. All state is URL-backed (stream-view-search.ts); the
 * event-type and offset filters only apply to the feed-items collection, so
 * they hide on the agent-chat preset.
 */
export function StreamFeedFilterRow({
  activePreset,
  defaultPresetId,
  eventCount,
  connectionStatus,
  feedDatabase,
  presets,
}: {
  activePreset: StreamFeedPreset;
  defaultPresetId: string;
  eventCount: number;
  connectionStatus: string;
  /** The feed-items mirror backing the event-type filter's counts. */
  feedDatabase: StreamBrowserDatabase;
  presets: readonly StreamFeedPreset[];
}) {
  const { search, setSearch } = useStreamViewSearch();
  // The row mounts when the filter toggle opens it, so focusing on mount lands
  // the cursor in the search box exactly when the user asked to filter. A
  // stable ref callback runs once per mount (an inline one would re-run — and
  // steal focus — on every render).
  const focusOnMount = useCallback((element: HTMLInputElement | null) => element?.focus(), []);

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-1.5 pt-1">
      <div
        className="flex flex-wrap items-center gap-1.5"
        role="radiogroup"
        aria-label="Feed preset"
        data-testid="stream-feed-preset"
      >
        {presets.map((preset) => {
          const active = preset.id === activePreset.id;
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() =>
                setSearch({
                  preset: preset.id === defaultPresetId ? undefined : preset.id,
                  // The event-type list is scoped to a preset's event family;
                  // types from the old preset would silently empty the new one.
                  types: undefined,
                })
              }
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                active
                  ? "border-transparent bg-foreground text-background"
                  : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      <div className="flex h-8 min-w-0 max-w-xs flex-1 items-center gap-2 rounded-full bg-muted px-3">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={focusOnMount}
          value={search.q ?? ""}
          onChange={(event) => setSearch({ q: event.target.value || undefined })}
          placeholder="Search feed…"
          aria-label="Search feed"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      {activePreset.kind === "feed-items" ? (
        <>
          <FeedEventTypesFilter
            database={feedDatabase}
            eventTypePrefix={activePreset.eventTypePrefix ?? null}
            value={search.types ?? null}
            onChange={(types) => setSearch({ types: types ?? undefined })}
          />
          <div
            className="flex items-center gap-1 font-mono text-xs text-muted-foreground"
            title="Raw event offset range"
          >
            <OffsetBoundInput
              label="From offset"
              placeholder="from #"
              value={search.from}
              onChange={(from) => setSearch({ from })}
            />
            –
            <OffsetBoundInput
              label="To offset"
              placeholder="to #"
              value={search.to}
              onChange={(to) => setSearch({ to })}
            />
          </div>
        </>
      ) : null}
      <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
        {eventCount.toLocaleString()} events · {connectionStatus}
      </span>
    </div>
  );
}

function OffsetBoundInput({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      aria-label={label}
      placeholder={placeholder}
      value={value ?? ""}
      onChange={(event) => {
        const parsed = event.target.value === "" ? undefined : Number(event.target.value);
        onChange(parsed != null && Number.isFinite(parsed) ? parsed : undefined);
      }}
      className="h-8 w-20 rounded-full bg-muted px-3 text-xs outline-none placeholder:text-muted-foreground [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
    />
  );
}
