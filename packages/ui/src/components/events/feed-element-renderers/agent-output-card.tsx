"use client";

import { SparklesIcon } from "lucide-react";

import {
  Message,
  MessageContent,
  MessageResponse,
} from "@iterate-com/ui/components/ai-elements/message";
import type { EventsStreamAgentOutputElement } from "@iterate-com/ui/components/events/feed-items";
import { ExpandableFeedText } from "@iterate-com/ui/components/events/feed-element-renderers/expandable-feed-text";

export function AgentOutputCard({ element }: { element: EventsStreamAgentOutputElement }) {
  return (
    <Message from="assistant" className="max-w-3xl">
      <MessageContent className="w-full gap-2 rounded-none border-0 bg-transparent px-0 py-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2 py-1 text-xs text-muted-foreground">
          <SparklesIcon className="size-3.5 shrink-0" />
          <span className="shrink-0 font-medium text-foreground">LLM output added</span>
        </div>

        <ExpandableFeedText text={element.props.text} collapsedLabel="Show full output">
          <MessageResponse className="min-w-0 max-w-full text-sm leading-6">
            {element.props.text}
          </MessageResponse>
        </ExpandableFeedText>
      </MessageContent>
    </Message>
  );
}
