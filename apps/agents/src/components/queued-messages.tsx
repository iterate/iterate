// The queued-messages panel: messages that landed while a turn was running, rendered as
// PART OF THE COMPOSER — input that has not reached the agent yet belongs with the input surface,
// not in the feed's history. A rounded card tucked behind the pill; on phones only the newest
// message stays pinned, with a "+N more" toggle.
import { useState } from "react";
import { BanIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { cn } from "cn";
import type { AgentUiMessageItem } from "../lib/events/agent-ui-reducer.ts";
import { UserMessageBody, type SignedUrl } from "./agent-feed.tsx";

export function QueuedMessagesPanel({
  messages,
  isInterrupting,
  onInterrupt,
  signedUrl,
}: {
  messages: AgentUiMessageItem[];
  isInterrupting: boolean;
  onInterrupt?: () => Promise<void> | void;
  signedUrl: SignedUrl;
}) {
  const [expanded, setExpanded] = useState(false);
  if (messages.length === 0) return null;
  const hiddenCount = messages.length - 1;
  return (
    <div
      className="-mb-4 rounded-t-3xl border border-b-0 bg-muted/40 px-3 pb-6 pt-1.5"
      data-testid="queued-messages-panel"
    >
      <div className="flex items-center gap-2 px-1.5 py-1">
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          Queued for the next agent turn
        </span>
        {hiddenCount > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="shrink-0 font-mono text-[11px] text-muted-foreground underline-offset-2 hover:underline sm:hidden"
          >
            {expanded ? "collapse" : `+${String(hiddenCount)} more`}
          </button>
        ) : null}
        {onInterrupt ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onInterrupt()}
            disabled={isInterrupting}
            className="ml-auto h-6 shrink-0 gap-1 px-2 text-[11px] text-red-700 hover:bg-red-50 hover:text-red-800"
          >
            {isInterrupting ? (
              <Spinner className="size-3" />
            ) : (
              <BanIcon className="size-3 text-current" />
            )}
            Interrupt & send now
          </Button>
        ) : null}
      </div>
      <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
        {messages.map((message, index) => (
          <div
            key={message.id}
            className={cn(
              "rounded-xl border bg-background/80 px-3 py-1.5 text-sm",
              // The mobile push-out: only the newest message stays pinned to the composer while
              // collapsed.
              !expanded && index < messages.length - 1 && "hidden sm:block",
            )}
          >
            <UserMessageBody item={message} signedUrl={signedUrl} />
          </div>
        ))}
      </div>
    </div>
  );
}
