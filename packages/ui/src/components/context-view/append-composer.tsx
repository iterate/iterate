// The context view's raw composer, the old platform's (apps/os `stream-view-composer.tsx` raw mode
// and `example-events-panel.tsx`, removed in #2837): YAML (or JSON) for one event or a list of
// them, sent through the caller's `onAppend` with ⌘/Ctrl+Enter or the button. Closed it is one
// "Append event" button under the feed, in the rows' body column, so it never eats the log; open,
// in the same column under one rule, the editor is capped (12rem) and the feed keeps the rest. Typing completes the event's fields and, after `type:`, the types
// this context knows (append-completions.ts); "Examples" loads a draft of a type some processor here
// consumes, grouped by processor. Nothing is inserted here: the appended events arrive by the view's
// live subscription like anyone's, and the view pins the feed to its tail so they land in view. The
// draft stays after a success — the next append is usually a tweak of the last.
import { useMemo, useRef, useState } from "react";
import { PlusIcon, SparklesIcon } from "lucide-react";
import { Button } from "../button.tsx";
import { CodeEditor } from "../code-editor.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../dropdown-menu.tsx";
import { Spinner } from "../spinner.tsx";
import { RowGutter } from "./event-row.tsx";
import { appendCompletionsAt, knownEventTypes } from "./append-completions.ts";
import {
  DEFAULT_APPEND_YAML,
  exampleGroups,
  exampleYaml,
  parseAppendYaml,
  type ContextViewAppendEvent,
} from "./append-events.ts";
import { recount, shortEventType, sortedCounts, type TypeCounts } from "./filters.tsx";
import type { ContextViewEvent, ContextViewProcessor } from "./types.tsx";

export function AppendComposer({
  onAppend,
  onAppended,
  events,
  processors,
}: {
  onAppend: (events: ContextViewAppendEvent[]) => Promise<unknown>;
  /** After a success: the view follows its tail to show what lands. */
  onAppended: () => void;
  /** The loaded log: its types are offered as you type one. */
  events: readonly ContextViewEvent[];
  /** The context's processors: what they consume is offered first, and loads as an example. */
  processors: readonly ContextViewProcessor[];
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(DEFAULT_APPEND_YAML);
  const [pending, setPending] = useState(false);
  /** The last submit's outcome, until the draft changes. */
  const [outcome, setOutcome] = useState<{ error: string } | { appended: number }>();
  const examples = useMemo(() => exampleGroups(processors), [processors]);
  // counted only while open, and then only what the log adds (filters.tsx `recount`)
  const countsRef = useRef<TypeCounts>(undefined);
  const known = useMemo(
    () =>
      open
        ? knownEventTypes(
            sortedCounts((countsRef.current = recount(countsRef.current, events)).counts),
            processors,
          )
        : [],
    [open, events, processors],
  );
  const edit = (value: string) => {
    setDraft(value);
    setOutcome(undefined);
  };
  const blank = draft.trim() === "";
  const submit = async () => {
    if (pending || blank) return;
    const parsed = parseAppendYaml(draft);
    if ("error" in parsed) return setOutcome(parsed);
    setPending(true);
    try {
      await onAppend(parsed.events);
      setOutcome({ appended: parsed.events.length });
      onAppended();
    } catch (error) {
      setOutcome({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      setPending(false);
    }
  };
  if (!open)
    return (
      <div className="flex items-center gap-x-3.5 px-3 sm:px-4 py-1">
        <RowGutter times />
        {/* the button's own padding sits outside the column, so its words line up with the rows' */}
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setOpen(true)}>
          <PlusIcon /> Append event
        </Button>
        <span className="hidden text-xs text-muted-foreground sm:inline">YAML · ⌘↵</span>
      </div>
    );
  return (
    <div className="flex gap-x-3.5 border-t px-3 sm:px-4 pt-2 pb-1" data-slot="append-composer">
      <RowGutter times />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <CodeEditor
          value={draft}
          onValueChange={edit}
          onSubmit={() => void submit()}
          language="yaml"
          label="Events to append"
          placeholder="type: manual/note-added  (a YAML list appends several)"
          focusOnMount
          complete={(text, pos, explicit) => appendCompletionsAt(text, pos, explicit, known)}
        />
        <div className="flex flex-wrap items-center gap-2">
          {examples.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
                <SparklesIcon /> Examples
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-auto max-w-80">
                {examples.map((group) => (
                  <DropdownMenuGroup key={group.label}>
                    <DropdownMenuLabel className="truncate">{group.label}</DropdownMenuLabel>
                    {group.types.map((type) => (
                      <DropdownMenuItem
                        key={type}
                        title={type}
                        onClick={() => edit(exampleYaml(type))}
                        className="font-mono text-xs"
                      >
                        <span className="truncate">{shortEventType(type)}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-xs" role="status">
            {outcome && "error" in outcome ? (
              <span data-type="error" className="text-destructive" title={outcome.error}>
                {outcome.error}
              </span>
            ) : outcome ? (
              <span className="text-muted-foreground">
                Appended {outcome.appended === 1 ? "1 event" : `${String(outcome.appended)} events`}
              </span>
            ) : (
              <span className="hidden text-muted-foreground sm:inline">
                YAML or JSON · Tab completes · ⌘↵ appends
              </span>
            )}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Close
          </Button>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={pending || blank}
            title="Append events (⌘↵)"
          >
            {pending ? <Spinner /> : null} Append
          </Button>
        </div>
      </div>
    </div>
  );
}
