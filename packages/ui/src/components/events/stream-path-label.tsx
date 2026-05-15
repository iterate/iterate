import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { cn } from "@iterate-com/ui/lib/utils";

/**
 * Tooltip-backed stream path label.
 *
 * Uses CSS text-overflow so the full path is shown whenever it fits,
 * and only truncated (with ellipsis at the end) when space is tight.
 * The full path is always available on hover via tooltip.
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
  const textNode = (
    <span className={cn("block min-w-0 truncate whitespace-nowrap font-mono", className)}>
      {displayValue}
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex min-w-0 max-w-full" />}>
        {textNode}
      </TooltipTrigger>
      <TooltipContent>
        <p className="font-mono text-xs">{path}</p>
      </TooltipContent>
    </Tooltip>
  );
}
