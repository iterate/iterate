import type { ReactNode } from "react";

import { IterateMark } from "@iterate-com/ui/components/iterate-mark";
import { cn } from "@iterate-com/ui/lib/utils";

const ITERATE_EVENT_TYPE_PREFIX = "events.iterate.com/";
const ITERATE_EVENT_TYPE_URL_PREFIX = "https://events.iterate.com/";

export type StreamEventTypeLinkProps = {
  href: string;
  children: ReactNode;
  className?: string;
};

export type StreamEventTypeLinkRenderer = (props: StreamEventTypeLinkProps) => ReactNode;

/**
 * Compact event type label for stream UIs.
 *
 * Iterate-owned event types replace the `events.iterate.com/` prefix with the
 * iterate mark. Linking is optional and owned here so every event-type surface
 * uses the same brand and docs affordance.
 */
export function StreamEventType({
  type,
  href,
  getHref,
  renderLink,
  className,
}: {
  type: string;
  href?: string;
  getHref?: (eventType: string) => string | undefined;
  renderLink?: StreamEventTypeLinkRenderer;
  className?: string;
}) {
  const resolvedHref = href ?? getHref?.(type);
  const label = (
    <StreamEventTypeLabel type={type} className={resolvedHref == null ? className : undefined} />
  );

  if (resolvedHref == null) {
    return label;
  }

  const linkClassName = cn(
    "inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-primary hover:underline",
    className,
  );
  const linkedChildren = <StreamEventTypeLabel type={type} />;

  if (renderLink != null) {
    return renderLink({
      href: resolvedHref,
      className: linkClassName,
      children: linkedChildren,
    });
  }

  return (
    <a href={resolvedHref} target="_blank" rel="noreferrer" className={linkClassName}>
      {linkedChildren}
    </a>
  );
}

function StreamEventTypeLabel({ type, className }: { type: string; className?: string }) {
  const iterateType = getIterateEventTypeLabel(type);

  if (iterateType == null) {
    return <span className={cn("font-mono", className)}>{type}</span>;
  }

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 font-mono", className)}>
      <IterateMark aria-hidden />
      <span className="truncate">{iterateType}</span>
    </span>
  );
}

function getIterateEventTypeLabel(type: string) {
  if (type.startsWith(ITERATE_EVENT_TYPE_PREFIX)) {
    return `/${type.slice(ITERATE_EVENT_TYPE_PREFIX.length)}`;
  }

  if (type.startsWith(ITERATE_EVENT_TYPE_URL_PREFIX)) {
    return `/${type.slice(ITERATE_EVENT_TYPE_URL_PREFIX.length)}`;
  }

  return null;
}
