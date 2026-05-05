import { StreamEventType } from "@iterate-com/ui/components/events/stream-event-type";
import { getProcessorEventDocByType } from "~/lib/processor-docs.ts";

export function CoreEventTypeLabel({ type, className }: { type: string; className?: string }) {
  return <StreamEventType type={type} className={className} />;
}

export function EventType({ type, className }: { type: string; className?: string }) {
  return (
    <StreamEventType
      type={type}
      getHref={(eventType) => getProcessorEventDocByType(eventType)?.href}
      className={className}
    />
  );
}
