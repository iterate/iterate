import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@iterate-com/ui/components/collapsible";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import type { ErrorFeedItem } from "~/lib/stream-feed-types.ts";

export function StreamErrorAlert({ item }: { item: ErrorFeedItem }) {
  const [open, setOpen] = useState(false);
  const hasExtraDetail = Boolean(item.stack || item.raw != null);

  return (
    <article
      className="max-w-md rounded-lg border border-destructive/35 bg-card p-4 shadow-sm"
      data-label="stream-error-alert"
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <div className="text-xs font-medium uppercase tracking-wide text-destructive">
              Stream error
            </div>
            <h3 className="text-sm font-semibold leading-snug text-foreground">{item.message}</h3>
          </div>
          <span className="shrink-0 rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
            {formatTime(item.timestamp)}
          </span>
        </div>

        {item.context ? <p className="text-xs text-muted-foreground">{item.context}</p> : null}

        {hasExtraDetail ? (
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto gap-1 px-0 text-xs text-muted-foreground hover:text-foreground"
                />
              }
            >
              <ChevronDownIcon
                className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
              />
              {open ? "Hide technical details" : "Show technical details"}
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-2">
              {item.stack ? (
                <div className="space-y-1">
                  <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Stack
                  </div>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs text-destructive">
                    {item.stack}
                  </pre>
                </div>
              ) : null}
              {item.raw != null ? (
                <div className="space-y-1">
                  <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Raw diagnostic
                  </div>
                  <SerializedObjectCodeBlock
                    data={item.raw}
                    className="min-h-32 max-h-64"
                    initialFormat="yaml"
                    showToggle
                    showCopyButton
                  />
                </div>
              ) : null}
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    </article>
  );
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString();
}
