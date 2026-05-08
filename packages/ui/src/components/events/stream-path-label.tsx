import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { cn } from "@iterate-com/ui/lib/utils";

/**
 * Compact, tooltip-backed stream path label.
 *
 * Stream paths can be deeply nested, so stream UIs should truncate the middle
 * while keeping the full path available on hover. Navigation remains app-owned;
 * this component only renders the path text consistently.
 */
export function EventsStreamPathLabel({
  path,
  label,
  className,
  startChars = 16,
  endChars = 14,
}: {
  path: string;
  label?: string;
  className?: string;
  startChars?: number;
  endChars?: number;
}) {
  const displayValue = label ?? path;
  const truncated = truncateMiddle(displayValue, { endChars, startChars });
  const textNode = (
    <span className={cn("block min-w-0 whitespace-nowrap font-mono", className)}>{truncated}</span>
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

function truncateMiddle(
  value: string,
  {
    startChars,
    endChars,
  }: {
    startChars: number;
    endChars: number;
  },
) {
  if (value.length <= startChars + endChars + 1) {
    return value;
  }

  return `${value.slice(0, startChars)}...${value.slice(-endChars)}`;
}
