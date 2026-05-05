"use client";

import { useState } from "react";
import { ChevronDownIcon, Settings2Icon } from "lucide-react";

import {
  Message,
  MessageContent,
  MessageResponse,
} from "@iterate-com/ui/components/ai-elements/message";
import { Button } from "@iterate-com/ui/components/button";
import type { EventsStreamSystemPromptElement } from "@iterate-com/ui/components/events/feed-items";
import { cn } from "@iterate-com/ui/lib/utils";

const COLLAPSED_MAX_HEIGHT_CLASS = "max-h-44";
const EXPAND_THRESHOLD_CHARS = 700;
const EXPAND_THRESHOLD_LINES = 10;

export function SystemPromptCard({ element }: { element: EventsStreamSystemPromptElement }) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = shouldOfferExpansion(element.props.text);

  return (
    <Message from="user" className="max-w-3xl">
      <MessageContent className="w-full gap-2 rounded-none border-0 bg-transparent px-0 py-0 group-[.is-user]:rounded-none group-[.is-user]:bg-transparent group-[.is-user]:px-0 group-[.is-user]:py-0">
        <div className="flex min-w-0 items-center gap-2 py-1 text-xs text-muted-foreground">
          <Settings2Icon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 font-medium text-foreground">
            System prompt updated (instructions for the LLM)
          </span>
        </div>

        <div className="relative min-w-0 overflow-hidden rounded-lg border bg-background shadow-xs">
          <div
            className={cn(
              "overflow-hidden px-4 py-3",
              canExpand && "pb-12",
              canExpand && !expanded && COLLAPSED_MAX_HEIGHT_CLASS,
            )}
          >
            <MessageResponse className="min-w-0 max-w-full text-sm leading-6 text-muted-foreground">
              {element.props.text}
            </MessageResponse>
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
              {expanded ? "Show less" : "Show full prompt"}
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
              />
            </Button>
          ) : null}
        </div>
      </MessageContent>
    </Message>
  );
}

function shouldOfferExpansion(text: string) {
  return text.length > EXPAND_THRESHOLD_CHARS || text.split("\n").length > EXPAND_THRESHOLD_LINES;
}
