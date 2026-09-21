// The inspector: one event, whole, in a right-edge sheet — the envelope with its stamp, and the
// body as YAML or JSON (SerializedObjectCodeBlock), copyable.
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../sheet.tsx";
import { SerializedObjectCodeBlock } from "../serialized-object-code-block.tsx";
import { actorLabel, shortEventType } from "./filters.tsx";
import type { ContextViewEvent } from "./types.tsx";

export function EventInspector({
  event,
  onClose,
}: {
  event: ContextViewEvent | undefined;
  onClose: () => void;
}) {
  return (
    <Sheet open={Boolean(event)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        {event ? (
          <>
            <SheetHeader>
              <SheetTitle className="font-mono text-sm">
                #{event.offset} · {shortEventType(event.type)}
              </SheetTitle>
              <SheetDescription>
                {new Date(event.createdAt).toISOString()}
                {actorLabel(event) ? ` · ${actorLabel(event)}` : ""}
                {event.source?.grant ? ` · ${event.source.grant}` : ""}
                {event.source?.processor
                  ? ` · ${event.source.processor.slug}@${event.source.processor.version}`
                  : ""}
              </SheetDescription>
            </SheetHeader>
            <div className="px-4 pb-4">
              <SerializedObjectCodeBlock data={event} initialFormat="json" showToggle />
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
