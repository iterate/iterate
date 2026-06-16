import { useMemo } from "react";
import { stringify as stringifyYaml } from "yaml";
import { cn } from "@iterate-com/ui/lib/utils";
import type { AgentUiPresenceEntry } from "@iterate-com/ui/components/events/agent-ui-reducer";
import { getProcessorDocByPath, type EventDoc } from "~/lib/event-docs.ts";
import { hashString } from "~/lib/stream-presence.ts";

// Solid dot colours, hashed by processor slug so each connected processor keeps
// a stable colour that matches its presence avatar's hue family.
const DOT_PALETTE = [
  "bg-sky-500",
  "bg-violet-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-indigo-500",
];

type ExampleGroup = { slug: string; events: EventDoc[] };

/**
 * The composer's "Examples" body: every processor currently subscribed to the
 * stream contributes its contract's events, and clicking one loads a ready
 * example (or a typed skeleton) into the raw editor. The catalog comes straight
 * from the processor contracts via `event-docs`, so it stays in sync with what
 * the processors actually announce.
 */
export function ExampleEventsPanel({
  presence,
  onLoadExample,
}: {
  presence: readonly AgentUiPresenceEntry[];
  onLoadExample: (yaml: string) => void;
}) {
  const groups = useMemo(() => buildGroups(presence), [presence]);

  return (
    <div>
      <p className="mb-3 text-xs text-muted-foreground">
        Example events from connected processors — click to load into the raw editor.
      </p>
      {groups.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          No connected processors announced any example events yet.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <div key={group.slug}>
              <div className="mb-2 flex items-center gap-2">
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    DOT_PALETTE[hashString(group.slug) % DOT_PALETTE.length],
                  )}
                />
                <span className="font-mono text-sm">{group.slug}</span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {group.events.map((event) => (
                  <button
                    key={event.type}
                    type="button"
                    onClick={() => onLoadExample(exampleYaml(event))}
                    className="min-w-0 rounded-xl border bg-background px-4 py-3 text-left transition-colors hover:border-foreground/20 hover:bg-muted/40"
                  >
                    <div className="truncate font-mono text-sm">
                      {event.type.replace("events.iterate.com/", "")}
                    </div>
                    {event.description == null ? null : (
                      <div className="mt-0.5 truncate text-sm text-muted-foreground">
                        {event.description}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function buildGroups(presence: readonly AgentUiPresenceEntry[]): ExampleGroup[] {
  const seen = new Set<string>();
  const groups: ExampleGroup[] = [];
  for (const entry of presence) {
    const slug = entry.processor?.slug;
    if (slug == null || seen.has(slug)) continue;
    seen.add(slug);
    const doc = getProcessorDocByPath(slug);
    if (doc == null || doc.events.length === 0) continue;
    groups.push({ slug, events: doc.events });
  }
  return groups;
}

function exampleYaml(event: EventDoc): string {
  const payload = event.examples[0]?.payload ?? {};
  return stringifyYaml({ type: event.type, payload });
}
