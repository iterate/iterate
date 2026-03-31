"use client";

import * as React from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "@iterate-com/ui/lib/utils";

/**
 * Compact fixed-width identifier pill for IDs and slugs.
 *
 * This is intentionally tiny and reusable: render the identifier in a monospaced
 * style, and keep a copy affordance attached to the trailing edge so IDs/slugs
 * are easy to grab while browsing admin-ish UIs.
 */
export function Identifier({
  value,
  className,
  textClassName,
}: {
  value: string;
  className?: string;
  textClassName?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  async function handleCopy(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 pl-0 pr-0 py-0", className)}>
      <span className={cn("min-w-0 truncate font-mono text-sm", textClassName)} title={value}>
        {value}
      </span>
      <button
        type="button"
        aria-label={copied ? "Copied" : `Copy ${value}`}
        onClick={handleCopy}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </button>
    </span>
  );
}
