// The context view's raw composer, the old platform's (apps/os `stream-view-composer.tsx` raw mode
// and `example-events-panel.tsx`, removed in #2837): YAML for one event or a list of them, sent
// through the caller's `onAppend` with ⌘/Ctrl+Enter or the button. Closed it is one "Append event"
// button under the feed, so it never eats the log; open, the editor is capped (12rem) and the feed
// keeps the rest. Nothing is inserted here: the appended events arrive by the view's live
// subscription like anyone's, and the view pins the feed to its tail so they land in view. The draft
// stays after a success — the next append is usually a tweak of the last.
import { useState } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "../button.tsx";
import { CodeEditor } from "../code-editor.tsx";
import { NativeSelect, NativeSelectOption } from "../native-select.tsx";
import { Spinner } from "../spinner.tsx";
import {
  DEFAULT_APPEND_YAML,
  exampleYaml,
  parseAppendYaml,
  type ContextViewAppendEvent,
} from "./append-events.ts";

export function AppendComposer({
  onAppend,
  onAppended,
  exampleTypes,
}: {
  onAppend: (events: ContextViewAppendEvent[]) => Promise<unknown>;
  /** After a success: the view follows its tail to show what lands. */
  onAppended: () => void;
  /** Types some processor here consumes, to load as a draft; empty = no picker. */
  exampleTypes: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(DEFAULT_APPEND_YAML);
  const [pending, setPending] = useState(false);
  /** The last submit's outcome, until the draft changes. */
  const [outcome, setOutcome] = useState<{ error: string } | { appended: number }>();
  const edit = (value: string) => {
    setDraft(value);
    setOutcome(undefined);
  };
  const submit = async () => {
    if (pending) return;
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
      <div>
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          <PlusIcon /> Append event
        </Button>
      </div>
    );
  return (
    <div className="flex flex-col gap-2 border-t pt-2" data-slot="append-composer">
      <CodeEditor
        value={draft}
        onValueChange={edit}
        onSubmit={() => void submit()}
        language="yaml"
        label="Events to append"
        placeholder="type: …  (a list appends several)"
        focusOnMount
      />
      <div className="flex flex-wrap items-center gap-2">
        {exampleTypes.length > 0 ? (
          <NativeSelect
            size="sm"
            aria-label="Load an example"
            value=""
            onChange={(event) => {
              if (event.target.value) edit(exampleYaml(event.target.value));
            }}
            className="max-w-64 min-w-0 font-mono text-xs"
          >
            <NativeSelectOption value="">Examples…</NativeSelectOption>
            {exampleTypes.map((type) => (
              <NativeSelectOption key={type} value={type}>
                {type.replace("events.iterate.com/", "")}
              </NativeSelectOption>
            ))}
          </NativeSelect>
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
              One event, or a YAML list of them · ⌘↵ appends
            </span>
          )}
        </span>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Close
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={pending}>
          {pending ? <Spinner /> : null} Append
        </Button>
      </div>
    </div>
  );
}
