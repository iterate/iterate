"use client";

import { useState, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";

import { Button } from "@iterate-com/ui/components/button";
import { cn } from "@iterate-com/ui/lib/utils";

const COLLAPSED_MAX_HEIGHT_CLASS = "max-h-44";
const EXPAND_THRESHOLD_CHARS = 700;
const EXPAND_THRESHOLD_LINES = 10;

export function ExpandableFeedText({
  text,
  children,
  collapsedLabel,
  expandedLabel = "Show less",
  className,
  contentClassName,
}: {
  text: string;
  children: ReactNode;
  collapsedLabel: string;
  expandedLabel?: string;
  className?: string;
  contentClassName?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand =
    text.length > EXPAND_THRESHOLD_CHARS || text.split("\n").length > EXPAND_THRESHOLD_LINES;

  return (
    <div
      className={cn(
        "relative min-w-0 overflow-hidden rounded-lg border bg-background shadow-xs",
        className,
      )}
    >
      <div
        className={cn(
          "overflow-hidden px-4 py-3",
          canExpand && "pb-12",
          canExpand && !expanded && COLLAPSED_MAX_HEIGHT_CLASS,
          contentClassName,
        )}
      >
        {children}
      </div>

      {canExpand && !expanded ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-linear-to-b from-transparent to-background" />
      ) : null}

      {canExpand ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="absolute right-2 bottom-2 z-10 h-7 gap-1.5 border bg-background/90 px-2 text-xs shadow-xs backdrop-blur-sm hover:bg-muted"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? expandedLabel : collapsedLabel}
          <ChevronDownIcon
            className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
          />
        </Button>
      ) : null}
    </div>
  );
}
