// The inspector: one event, whole, in a right-edge sheet (full width on a phone) — the envelope
// as a small table (offset, type, when, who, grant, processor, idempotency key), a rich body when
// an inspector is registered for the type (the message as prose, the script as code), and the raw
// event as JSON or YAML, copyable.
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../sheet.tsx";
import { SerializedObjectCodeBlock } from "../serialized-object-code-block.tsx";
import { actorLabel, shortEventType } from "./filters.tsx";
import {
  type ContextViewEvent,
  type EventInspectors,
  type EventRenderers,
  rendererFor,
} from "./types.tsx";

export function EventInspector({
  event,
  renderers,
  inspectors,
  onClose,
}: {
  event: ContextViewEvent | undefined;
  renderers?: EventRenderers;
  inspectors?: EventInspectors;
  onClose: () => void;
}) {
  const sentence = event ? (rendererFor(renderers, event.type)?.(event) ?? null) : null;
  const body = event ? (rendererFor(inspectors, event.type)?.(event) ?? null) : null;
  const envelope: [label: string, value: string][] = event
    ? [
        ["Offset", `#${String(event.offset)}`],
        ["Type", event.type],
        ["At", new Date(event.createdAt).toISOString()],
        ["Who", actorLabel(event)],
        ["Grant", event.source?.grant || ""],
        [
          "Processor",
          event.source?.processor
            ? `${event.source.processor.slug}@${event.source.processor.version}`
            : "",
        ],
        ["Idempotency key", event.idempotencyKey || ""],
      ].filter((row): row is [string, string] => Boolean(row[1]))
    : [];
  return (
    <Sheet open={Boolean(event)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        {event ? (
          <>
            <SheetHeader>
              <SheetTitle className="text-sm [&_*]:inline">
                {sentence ?? <span className="font-mono">{shortEventType(event.type)}</span>}
              </SheetTitle>
              <SheetDescription className="font-mono text-xs">
                #{event.offset} · {shortEventType(event.type)}
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-4 px-4 pb-4">
              {body ? <div className="min-w-0">{body}</div> : null}
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                {envelope.map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="min-w-0 truncate font-mono" title={value}>
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="min-w-0 overflow-x-auto">
                <SerializedObjectCodeBlock data={event} initialFormat="json" showToggle />
              </div>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
