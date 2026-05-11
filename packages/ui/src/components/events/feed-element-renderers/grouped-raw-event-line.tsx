import type { ReactNode } from "react";

import { Badge } from "@iterate-com/ui/components/badge";
import type { EventsStreamGroupedRawEventElement } from "@iterate-com/ui/components/events/feed-items";
import { StreamEventType } from "@iterate-com/ui/components/events/stream-event-type";
import { cn } from "@iterate-com/ui/lib/utils";

export function GroupedRawEventLine({
  element,
  elapsedLabel,
  onOpenEventOffsetChange,
}: {
  element: EventsStreamGroupedRawEventElement;
  elapsedLabel?: string;
  onOpenEventOffsetChange?: (offset?: number) => void;
}) {
  const firstOffset = element.props.events[0]?.offset;
  const showCount = element.props.count > 1;
  const showTimestampRange =
    element.props.count > 1 && element.props.firstTimestamp !== element.props.lastTimestamp;
  const openFirstEvent = () => onOpenEventOffsetChange?.(firstOffset);

  return (
    <div className="flex justify-end">
      <RawEventLineFrame>
        <RawEventInspectButton onClick={openFirstEvent} className="shrink-0 tabular-nums">
          #{firstOffset}
        </RawEventInspectButton>
        <RawEventTypeInspectButton type={element.props.eventType} onClick={openFirstEvent} />
        {showCount ? (
          <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
            x{element.props.count}
          </Badge>
        ) : null}
        {elapsedLabel ? (
          <>
            <span className="shrink-0">·</span>
            <RawEventInspectButton onClick={openFirstEvent} className="shrink-0 tabular-nums">
              {elapsedLabel}
            </RawEventInspectButton>
          </>
        ) : null}
        <span className="shrink-0">·</span>
        <RawEventInspectButton onClick={openFirstEvent} className="shrink-0 tabular-nums">
          <span className="shrink-0 tabular-nums">{formatTime(element.props.firstTimestamp)}</span>
        </RawEventInspectButton>
        {showTimestampRange ? (
          <RawEventInspectButton
            onClick={openFirstEvent}
            className="shrink-0 text-muted-foreground/70"
          >
            to {formatTime(element.props.lastTimestamp)}
          </RawEventInspectButton>
        ) : null}
      </RawEventLineFrame>
    </div>
  );
}

function RawEventLineFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 max-w-full items-center justify-end gap-2 rounded-md px-1 py-0.5 text-[11px] text-muted-foreground">
      {children}
    </div>
  );
}

function RawEventTypeInspectButton({ type, onClick }: { type: string; onClick: () => void }) {
  return (
    <RawEventInspectButton onClick={onClick} className="min-w-0">
      <StreamEventType type={type} className="min-w-0 truncate" />
    </RawEventInspectButton>
  );
}

function RawEventInspectButton({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString();
}
