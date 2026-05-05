import {
  Message,
  MessageContent,
  MessageResponse,
} from "@iterate-com/ui/components/ai-elements/message";
import type { EventsStreamMessageElement } from "@iterate-com/ui/components/events/feed-items";

export function MessageFeedItemCard({ element }: { element: EventsStreamMessageElement }) {
  if (element.props.format === "markdown") {
    return (
      <Message from={element.props.role}>
        <MessageContent>
          <MessageResponse className="min-w-0 max-w-full overflow-hidden">
            {element.props.text}
          </MessageResponse>
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message from={element.props.role}>
      <MessageContent>
        <div className="max-h-[40vh] max-w-full overflow-auto whitespace-pre-wrap wrap-break-word leading-6">
          {element.props.text}
        </div>
      </MessageContent>
    </Message>
  );
}
