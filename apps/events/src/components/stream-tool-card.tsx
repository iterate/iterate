import { useState } from "react";
import { ChevronDownIcon, CircleIcon, WrenchIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@iterate-com/ui/components/collapsible";
import { Message, MessageContent } from "@iterate-com/ui/components/ai-elements/message";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { cn } from "@iterate-com/ui/lib/utils";
import type { ToolFeedItem, ToolState } from "~/lib/stream-feed-types.ts";

const stateMeta: Record<
  ToolState,
  { label: string; fillClass: string; badgeClassName: string; pulse?: boolean }
> = {
  pending: {
    label: "Pending",
    fillClass: "fill-muted-foreground",
    badgeClassName: "border-border bg-muted text-muted-foreground",
  },
  running: {
    label: "Running",
    fillClass: "fill-amber-500",
    badgeClassName: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    pulse: true,
  },
  completed: {
    label: "Completed",
    fillClass: "fill-emerald-500",
    badgeClassName:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  error: {
    label: "Error",
    fillClass: "fill-destructive",
    badgeClassName: "border-destructive/30 bg-destructive/10 text-destructive",
  },
};

export function StreamToolCard({ item }: { item: ToolFeedItem }) {
  const [inputOpen, setInputOpen] = useState(true);
  const [outputOpen, setOutputOpen] = useState(false);
  const meta = stateMeta[item.state];

  return (
    <Message from="assistant" className="max-w-3xl" data-label="stream-tool-card">
      <MessageContent className="w-full gap-0 overflow-hidden rounded-xl border bg-card px-0 py-0 shadow-sm">
        <div className="border-b px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <WrenchIcon className="size-3.5 shrink-0" />
                <span>Tool</span>
              </div>
              <div className="font-mono text-sm font-medium leading-snug">{item.toolName}</div>
              <div className="font-mono text-[10px] text-muted-foreground">{item.toolCallId}</div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5",
                  meta.badgeClassName,
                )}
              >
                <CircleIcon
                  className={`size-2.5 ${meta.fillClass} ${meta.pulse ? "animate-pulse" : ""}`}
                />
                <span>{meta.label}</span>
              </span>
              <span>{formatTime(item.startTimestamp)}</span>
            </div>
          </div>

          {item.errorText ? (
            <p className="mt-3 text-xs text-destructive">{item.errorText}</p>
          ) : null}
        </div>

        <div className="space-y-2 px-4 py-3">
          <Collapsible open={inputOpen} onOpenChange={setInputOpen}>
            <CollapsibleTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto w-full justify-between gap-2 px-2 py-1.5 text-xs font-normal"
                />
              }
            >
              <span>Parameters</span>
              <ChevronDownIcon
                className={`size-3.5 shrink-0 transition-transform ${inputOpen ? "rotate-180" : ""}`}
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <SerializedObjectCodeBlock
                data={item.input}
                className="min-h-24 max-h-56"
                initialFormat="yaml"
                showToggle
                showCopyButton
              />
            </CollapsibleContent>
          </Collapsible>

          <Collapsible open={outputOpen} onOpenChange={setOutputOpen}>
            <CollapsibleTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto w-full justify-between gap-2 px-2 py-1.5 text-xs font-normal"
                />
              }
            >
              <span>Result{item.output === undefined ? " (pending)" : ""}</span>
              <ChevronDownIcon
                className={`size-3.5 shrink-0 transition-transform ${outputOpen ? "rotate-180" : ""}`}
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              {item.output !== undefined ? (
                <SerializedObjectCodeBlock
                  data={item.output}
                  className="min-h-24 max-h-56"
                  initialFormat="yaml"
                  showToggle
                  showCopyButton
                />
              ) : (
                <p className="text-xs text-muted-foreground">No output yet.</p>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      </MessageContent>
    </Message>
  );
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString();
}
