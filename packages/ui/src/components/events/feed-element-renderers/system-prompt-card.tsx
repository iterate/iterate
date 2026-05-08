"use client";

import { Settings2Icon } from "lucide-react";

import {
  Message,
  MessageContent,
  MessageResponse,
} from "@iterate-com/ui/components/ai-elements/message";
import type { EventsStreamSystemPromptElement } from "@iterate-com/ui/components/events/feed-items";
import { ExpandableFeedText } from "@iterate-com/ui/components/events/feed-element-renderers/expandable-feed-text";

export function SystemPromptCard({ element }: { element: EventsStreamSystemPromptElement }) {
  return (
    <Message from="user" className="max-w-3xl">
      <MessageContent className="w-full gap-2 rounded-none border-0 bg-transparent px-0 py-0 group-[.is-user]:rounded-none group-[.is-user]:bg-transparent group-[.is-user]:px-0 group-[.is-user]:py-0">
        <div className="flex min-w-0 items-center gap-2 py-1 text-xs text-muted-foreground">
          <Settings2Icon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 font-medium text-foreground">
            System prompt updated (instructions for the LLM)
          </span>
        </div>

        <ExpandableFeedText text={element.props.text} collapsedLabel="Show full prompt">
          <MessageResponse className="min-w-0 max-w-full text-sm leading-6 text-muted-foreground">
            {element.props.text}
          </MessageResponse>
        </ExpandableFeedText>
      </MessageContent>
    </Message>
  );
}
