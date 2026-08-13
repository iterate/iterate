import { StreamProcessor } from "iterate/processors";
import type { ProcessEventArgs, ReduceArgs } from "iterate/processors";
import {
  ChatReplyNotifyProcessorContract,
  type ChatReplyNotifyProcessorState,
} from "./chat-reply-notify-contract.ts";
import { markdownToPlainText } from "./markdown-plain-text.ts";

/** Push bodies carry the reply verbatim up to this length — roughly what iOS
 * shows expanded — then truncate with an ellipsis. */
const PUSH_BODY_MAX_LENGTH = 500;

/** How long a chat-reply push stays worth delivering. Anchored on the reply
 * event's own commit time (never `now`), so a redelivery re-derives the
 * identical intent body and dedupes on its key. */
const REPLY_PUSH_TTL_MS = 60 * 60_000;

/**
 * The chat-reply push producer, a sibling on plain chat agent streams.
 *
 * HOW IT WORKS: reduce tracks the one open "user turn" — the newest
 * user-authored context item the agent has not visibly answered (consecutive
 * user messages collapse; the actor's stamped userId rides along). When an
 * `agents/web-message-sent` reply closes an open turn, reduce stamps it into
 * `notifiableReply`, and the per-event lane appends ONE
 * `notification/requested` intent to the project root stream — addressed to
 * the turn's sender, deep-linking back into this thread, and carrying the
 * reply's own offset as the suppression handle a
 * `project/agent-reply-presented` claim is matched against (a client already
 * showing the reply keeps the phone quiet; the device processor owns that).
 * Replies with no open turn (agent monologues, agent↔agent traffic — those
 * context items are developer-role with agent actors) emit nothing, so one
 * push per answered user turn is the invariant.
 */
export class ChatReplyNotifyProcessor extends StreamProcessor<ChatReplyNotifyProcessorContract> {
  readonly contract = ChatReplyNotifyProcessorContract;

  protected override processEvent(
    args: ProcessEventArgs<ChatReplyNotifyProcessorContract>,
  ): undefined {
    const { event, state, appendTo, blockProcessorWhile } = args;
    if (event?.type !== "events.iterate.com/agents/web-message-sent") return;
    // State is post-reduce: a reply that closed an open turn is stamped as
    // notifiableReply with ITS OWN offset. Anything else (no turn open, or a
    // later multi-message burst) does not match and emits nothing.
    const reply = state.notifiableReply;
    if (!reply || reply.replyEventOffset !== event.offset) return;
    // Per-event consequence, so it blocks the checkpoint: this event is
    // delivered once, and a dropped append would silently lose the push.
    // Everything in the body derives from the event + turn identity alone,
    // so a redelivery re-appends the identical body and dedupes on the key.
    blockProcessorWhile(() =>
      appendTo("/", {
        type: "events.iterate.com/notification/requested",
        idempotencyKey: this.idempotencyKey("chat-reply", event),
        payload: {
          agentReplyEventOffset: event.offset,
          audience: !reply.userId ? { kind: "project" } : { kind: "user", userId: reply.userId },
          title: !state.title ? "Agent replied" : state.title,
          body: pushBody(event.payload.message),
          destination: { kind: "agent-chat", path: this.path },
          expiresAt: Date.parse(event.createdAt) + REPLY_PUSH_TTL_MS,
        },
      }),
    );
  }

  protected override reduce({
    event,
    state,
  }: ReduceArgs<ChatReplyNotifyProcessorContract>): ChatReplyNotifyProcessorState {
    switch (event.type) {
      case "events.iterate.com/chat-reply-notify/created":
        if (state.birthCertificate) return state;
        return { ...state, birthCertificate: event.payload };
      case "events.iterate.com/agents/context-added": {
        // Only user-authored turns owe a push; agent/script/integration
        // context (developer-role delegation traffic included) never opens
        // one. actor is optional on the wire — an actor-less user item still
        // opens a turn, just without a sender to address.
        const { actor, role } = event.payload;
        if (role !== "user" || (actor && actor.type !== "user")) return state;
        const userId = actor?.type === "user" && actor.userId ? actor.userId : null;
        return { ...state, pendingTurn: { messageOffset: event.offset, userId } };
      }
      case "events.iterate.com/agents/web-message-sent":
        if (!state.pendingTurn) return state;
        return {
          ...state,
          pendingTurn: null,
          notifiableReply: {
            replyEventOffset: event.offset,
            userId: state.pendingTurn.userId,
          },
        };
      case "events.iterate.com/agent/summary-updated": {
        // Title patches only (omission preserves, null clears) — the
        // conditional waiting-clear variant carries no title.
        // oxlint-disable-next-line iterate/simple-truthiness-check -- null CLEARS the title (falls back downstream); only undefined/omission preserves it
        if (!("title" in event.payload) || event.payload.title === undefined) return state;
        return { ...state, title: event.payload.title };
      }
      default:
        return state;
    }
  }
}

/** The push body: the reply flattened to plain text (push bodies can't render
 * markdown — stripped BEFORE truncation so markers don't eat the length
 * budget), bounded; a blank reply (files-only messages) still yields a valid
 * non-empty body. */
function pushBody(message: string): string {
  const text = markdownToPlainText(message);
  if (!text.length) return "Sent a reply.";
  if (text.length <= PUSH_BODY_MAX_LENGTH) return text;
  return `${text.slice(0, PUSH_BODY_MAX_LENGTH - 1)}…`;
}
