import type { ReactNode } from "react";

import { StreamEventType } from "@iterate-com/ui/components/events/stream-event-type";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { Link } from "@tanstack/react-router";
import { getProcessorEventDocByType } from "~/lib/processor-docs.ts";

const ITERATE_EVENT_TYPE_PREFIX = "events.iterate.com/";
const ITERATE_EVENT_TYPE_URL_PREFIX = "https://events.iterate.com/";

export function CoreEventTypeLabel({ type, className }: { type: string; className?: string }) {
  return (
    <EventTypeTooltip type={type}>
      <StreamEventType type={type} className={className} />
    </EventTypeTooltip>
  );
}

export function EventType({
  type,
  className,
  link = true,
}: {
  type: string;
  className?: string;
  link?: boolean;
}) {
  const label = (
    <StreamEventType
      type={type}
      getHref={link ? (eventType) => getProcessorEventDocByType(eventType)?.href : undefined}
      renderLink={({ href, className: linkClassName, children }) => (
        <Link to={href} className={linkClassName}>
          {children}
        </Link>
      )}
      className={className}
    />
  );

  return <EventTypeTooltip type={type}>{label}</EventTypeTooltip>;
}

function EventTypeTooltip({ type, children }: { type: string; children: ReactNode }) {
  if (!isIterateEventType(type)) {
    return children;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex min-w-0 max-w-full" />}>
        {children}
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <p className="font-mono text-xs wrap-break-word">{type}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function isIterateEventType(type: string) {
  return (
    type.startsWith(ITERATE_EVENT_TYPE_PREFIX) || type.startsWith(ITERATE_EVENT_TYPE_URL_PREFIX)
  );
}
