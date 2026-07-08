import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { cn } from "@iterate-com/ui/lib/utils";

/**
 * Tooltip-backed stream path label.
 *
 * Uses CSS text-overflow so the full path is shown whenever it fits,
 * and only truncated (with ellipsis at the end) when space is tight.
 * The tooltip reveals the full path, and only opens when it adds
 * information: when the label is abbreviated (`label` differs from
 * `path`) or when the displayed text is actually truncated. A label
 * that already shows the full path in full gets no tooltip.
 */
export function EventsStreamPathLabel({
  path,
  label,
  className,
}: {
  path: string;
  label?: string;
  className?: string;
}) {
  const displayValue = label ?? path;

  return (
    <Tooltip
      onOpenChange={(open, eventDetails) => {
        if (!open || displayValue !== path) return;
        const text = eventDetails.trigger?.querySelector("[data-slot=stream-path-label-text]");
        const truncated = text != null && text.scrollWidth > text.clientWidth;
        if (!truncated) eventDetails.cancel();
      }}
    >
      <TooltipTrigger render={<span className="inline-flex min-w-0 max-w-full" />}>
        <span
          data-slot="stream-path-label-text"
          className={cn("block min-w-0 truncate whitespace-nowrap font-mono", className)}
        >
          {displayValue}
        </span>
      </TooltipTrigger>
      {/* side="right" so an open tooltip never covers the list item above */}
      <TooltipContent side="right">
        <p className="font-mono text-xs">{path}</p>
      </TooltipContent>
    </Tooltip>
  );
}
