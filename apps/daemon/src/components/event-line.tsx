import { useState } from "react";
import { HarnessErrorAlert } from "./harness-error-alert.tsx";
import { SerializedObjectCodeBlock } from "./serialized-object-code-block.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import type { EventFeedItem, FeedItem, MessageFeedItem } from "@/reducers/messages-reducer.ts";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message.tsx";
import { Shimmer } from "@/components/ai-elements/shimmer.tsx";

function getMessageText(content: { type: string; text: string }[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function MessageBubble({ msg, isStreaming }: { msg: MessageFeedItem; isStreaming?: boolean }) {
  const text = getMessageText(msg.content);
  const timeStr = new Date(msg.timestamp).toLocaleTimeString();

  return (
    <Message from={msg.role}>
      <MessageContent>
        <div className="text-xs text-muted-foreground mb-1 flex items-center gap-2">
          <span>{msg.role === "user" ? "You" : "Assistant"}</span>
          <span>·</span>
          <span>{timeStr}</span>
          {isStreaming && <span className="animate-pulse">●</span>}
        </div>
        {text ? (
          <MessageResponse>{text}</MessageResponse>
        ) : isStreaming ? (
          <Shimmer className="text-sm">Thinking...</Shimmer>
        ) : (
          <span className="opacity-60 italic text-sm">Empty</span>
        )}
      </MessageContent>
    </Message>
  );
}

export function EventLine({ event }: { event: EventFeedItem }) {
  const [open, setOpen] = useState(false);
  const timeStr = new Date(event.timestamp).toLocaleTimeString();

  const raw = event.raw as Record<string, unknown> | null;
  const payload = raw?.payload as { piEventType?: string } | undefined;
  const piEventType = payload?.piEventType;

  return (
    <div className="flex justify-end">
      <Button
        variant="ghost"
        size="sm"
        className="h-auto py-0.5 px-2 text-xs text-muted-foreground hover:text-foreground gap-2"
        onClick={() => setOpen(true)}
      >
        <span className="font-mono">
          {event.eventType}
          {piEventType && <span className="text-foreground/60"> → {piEventType}</span>}
        </span>
        <span>·</span>
        <span>{timeStr}</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[100vw] max-w-[100vw] h-[100vh] max-h-[100vh] sm:w-[80vw] sm:max-w-[80vw] sm:h-[80vh] sm:max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">
              {event.eventType}
              {piEventType && <span className="text-muted-foreground"> → {piEventType}</span>}
              <span className="text-muted-foreground ml-2">· {timeStr}</span>
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-hidden">
            <SerializedObjectCodeBlock
              data={event.raw}
              className="h-full"
              initialFormat="yaml"
              showToggle
              showCopyButton
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function FeedItemRenderer({ item, isStreaming }: { item: FeedItem; isStreaming?: boolean }) {
  if (item.kind === "message") {
    return <MessageBubble msg={item} isStreaming={isStreaming} />;
  }
  if (item.kind === "error") {
    return <HarnessErrorAlert error={item} />;
  }
  return <EventLine event={item} />;
}
