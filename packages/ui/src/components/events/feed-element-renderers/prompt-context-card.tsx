"use client";

import { CornerDownRightIcon } from "lucide-react";

import {
  Message,
  MessageContent,
  MessageResponse,
} from "@iterate-com/ui/components/ai-elements/message";
import { Badge } from "@iterate-com/ui/components/badge";
import type { EventsStreamPromptContextElement } from "@iterate-com/ui/components/events/feed-items";
import { ExpandableFeedText } from "@iterate-com/ui/components/events/feed-element-renderers/expandable-feed-text";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { cn } from "@iterate-com/ui/lib/utils";

export function PromptContextCard({ element }: { element: EventsStreamPromptContextElement }) {
  const sourceLabel = element.props.source == null ? null : `from ${element.props.source}`;
  const policyLabel = element.props.llmRequestPolicy.behaviour;
  const policyDescription = describeLlmRequestPolicy(element.props.llmRequestPolicy);
  const canTriggerRequest = element.props.llmRequestPolicy.behaviour !== "dont-trigger-request";

  return (
    <Message from="user" className="max-w-3xl">
      <MessageContent className="w-full gap-2 rounded-none border-0 bg-transparent px-0 py-0 group-[.is-user]:rounded-none group-[.is-user]:bg-transparent group-[.is-user]:px-0 group-[.is-user]:py-0">
        <div className="flex min-w-0 items-center gap-2 py-1 text-xs text-muted-foreground">
          <CornerDownRightIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 font-medium text-foreground">
            Context added (by us, for the LLM to consider)
          </span>
          {sourceLabel == null ? null : <span className="min-w-0 truncate">{sourceLabel}</span>}
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Badge
                variant="outline"
                className={cn(
                  "font-mono shadow-none",
                  canTriggerRequest
                    ? "border-orange-300 bg-orange-50 text-orange-800 dark:border-orange-900/70 dark:bg-orange-950/40 dark:text-orange-300"
                    : "border-border/60 bg-muted/20 text-muted-foreground/75",
                )}
              >
                llmRequestPolicy: {policyLabel}
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p>{policyDescription}</p>
            </TooltipContent>
          </Tooltip>
        </div>

        <ExpandableFeedText text={element.props.text} collapsedLabel="Show full context">
          <MessageResponse className="min-w-0 max-w-full text-sm leading-6 text-muted-foreground">
            {element.props.text}
          </MessageResponse>
        </ExpandableFeedText>
      </MessageContent>
    </Message>
  );
}

function describeLlmRequestPolicy(
  policy: EventsStreamPromptContextElement["props"]["llmRequestPolicy"],
) {
  switch (policy.behaviour) {
    case "dont-trigger-request":
      return "Adds context for future LLM requests, but does not schedule a request by itself.";
    case "interrupt-current-request":
      return "Cancels any current LLM request and schedules a new one with this context included.";
    case "after-current-request":
      return "Requests an LLM response without interrupting in-flight work; debounced requests are reset so this context is included promptly.";
  }
}
