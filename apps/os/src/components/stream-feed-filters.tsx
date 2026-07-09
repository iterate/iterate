import { useCallback } from "react";
import { SearchIcon } from "lucide-react";
import { cn } from "@iterate-com/ui/lib/utils";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import { FeedComponentsFilter, FeedEventTypesFilter } from "~/components/feed-items-view.tsx";
import { defaultPresetForMode, type StreamFeedPreset } from "~/lib/stream-feed-filters.ts";
import {
  modeCapabilities,
  streamViewMode,
  useStreamViewSearch,
  type StreamViewMode,
} from "~/lib/stream-view-search.ts";

/**
 * Mode-owned filter row. Capabilities come from the active mode preset:
 * Pretty = search only; Pretty+raw / Raw = presets, components, event types,
 * offsets. All state is URL-backed (stream-view-search.ts).
 */
export function StreamFeedFilterRow({
  activePreset,
  eventCount,
  connectionStatus,
  feedDatabase,
  presets,
  streamPath,
}: {
  activePreset: StreamFeedPreset;
  eventCount: number;
  connectionStatus: string;
  feedDatabase: StreamBrowserDatabase;
  presets: readonly StreamFeedPreset[];
  streamPath: string;
}) {
  const { search, setSearch } = useStreamViewSearch();
  const mode = streamViewMode(search, streamPath);
  const caps = modeCapabilities(search, streamPath);
  const defaultPreset = defaultPresetForMode(streamPath, mode);
  const focusOnMount = useCallback((element: HTMLInputElement | null) => element?.focus(), []);

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-1.5 pt-1">
      {caps.rawPresets && presets.length > 1 ? (
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
                    preset: preset.id === defaultPreset.id ? undefined : preset.id,
                    types: undefined,
                    components: undefined,
                    from: undefined,
                    to: undefined,
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
      ) : null}
      {caps.search ? (
        <div className="flex h-8 min-w-0 max-w-xs flex-1 items-center gap-2 rounded-full bg-muted px-3">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={focusOnMount}
            value={search.q ?? ""}
            onChange={(event) => setSearch({ q: event.target.value || undefined })}
            placeholder={caps.agentFeed && !caps.rawFeed ? "Search chat…" : "Search feed…"}
            aria-label={caps.agentFeed && !caps.rawFeed ? "Search chat" : "Search feed"}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      ) : null}
      {caps.rawComponents ? (
        <FeedComponentsFilter
          database={feedDatabase}
          value={search.components ?? null}
          onChange={(components) => setSearch({ components: components ?? undefined })}
        />
      ) : null}
      {caps.rawEventTypes ? (
        <FeedEventTypesFilter
          database={feedDatabase}
          eventTypePrefix={activePreset.eventTypePrefix ?? null}
          value={search.types ?? null}
          onChange={(types) => setSearch({ types: types ?? undefined })}
        />
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
  );
}

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
        if (Number.isFinite(parsed)) onChange(Math.trunc(parsed));
      }}
      className="w-14 rounded-md border border-border bg-background px-1.5 py-0.5 text-center outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}
