// The context view's filter row, the old platform's (apps/os `stream-feed-filters.tsx`, removed in
// #2837): a search box that takes the focus when the row opens (Escape empties it), the log's types
// as chips with their counts (a ticked type the loaded log lacks still shows, at 0, so it can be
// unticked), an offset range `from`–`to`, and one "clear". Every value is the view's URL state; this
// only renders it and hands back patches.
import { useCallback } from "react";
import { SearchIcon } from "lucide-react";
import { cn } from "cn";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../input-group.tsx";
import { FILTER_CLEARED, type ContextViewState } from "./context-view-search.ts";
import { offsetBound, shortEventType, typeChips, type ContextViewFilter } from "./filters.tsx";

export function FilterRow({
  filter,
  counts,
  narrowed,
  partial,
  loaded,
  onStateChange,
}: {
  filter: ContextViewFilter;
  /** The loaded log's types with their counts, most frequent first. */
  counts: readonly [type: string, count: number][];
  /** Whether the filter narrows anything: "clear" shows. */
  narrowed: boolean;
  /** Older pages exist that the filter does not search. */
  partial: boolean;
  /** How many events are loaded, as the strip says it. */
  loaded: string;
  onStateChange: (patch: Partial<ContextViewState>) => void;
}) {
  const focusOnMount = useCallback((element: HTMLInputElement | null) => element?.focus(), []);
  const toggleType = (type: string) => {
    const next = filter.types.has(type)
      ? [...filter.types].filter((held) => held !== type)
      : [...filter.types, type];
    onStateChange({ types: next.length > 0 ? next : undefined });
  };
  return (
    <div className="flex flex-col gap-2" data-slot="filter-row">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <InputGroup className="h-8 min-w-48 flex-1">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            ref={focusOnMount}
            value={filter.query}
            onChange={(event) => onStateChange({ q: event.target.value || undefined })}
            onKeyDown={(event) => {
              if (event.key === "Escape" && filter.query) onStateChange({ q: undefined });
            }}
            placeholder="Search type or payload"
            aria-label="Search type or payload"
            className="text-base sm:text-sm"
          />
        </InputGroup>
        <div
          className="flex items-center gap-1 text-xs text-muted-foreground"
          title="Only the events between these offsets, inclusive"
        >
          <span>from</span>
          <OffsetInput
            label="From offset"
            value={filter.from}
            onChange={(from) => onStateChange({ from })}
          />
          <span>to</span>
          <OffsetInput
            label="To offset"
            value={filter.to}
            onChange={(to) => onStateChange({ to })}
          />
        </div>
      </div>
      <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
        {typeChips(counts, filter.types).map(([type, count]) => (
          <button
            key={type}
            type="button"
            onClick={() => toggleType(type)}
            aria-pressed={filter.types.has(type)}
            title={type}
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-xs hover:bg-muted",
              filter.types.has(type) ? "bg-muted text-foreground" : "text-muted-foreground",
            )}
          >
            {shortEventType(type)} <span className="tabular-nums">{count.toLocaleString()}</span>
          </button>
        ))}
        {narrowed ? (
          <button
            type="button"
            onClick={() => onStateChange(FILTER_CLEARED)}
            className="px-1.5 py-0.5 text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            clear
          </button>
        ) : null}
      </div>
      {partial ? (
        <p className="text-xs text-muted-foreground">
          The filter searches the {loaded} events loaded; scroll up to load older ones.
        </p>
      ) : null}
    </div>
  );
}

/** One end of the offset range: blank = open, a number = that offset (offsetBound). */
function OffsetInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <input
      inputMode="numeric"
      aria-label={label}
      placeholder="#"
      value={value ?? ""}
      onChange={(event) => {
        const bound = offsetBound(event.target.value);
        if (bound !== null) onChange(bound);
      }}
      className="h-7 w-16 rounded-md border bg-background px-1.5 text-center font-mono text-base tabular-nums sm:text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}
