// src/email/processor.ts — THE EMAIL PROCESSOR: the reduce of a project's messages, both directions,
// into threads. No effect: a PURE FOLD, so a unit test constructs it with `new` and reduces rows
// (processor.test.ts).
import { type ConsumedEvent, type ReduceArgs, StreamProcessor } from "iterate/stream/processor";
import { EmailContract, type EmailState } from "./contract.ts";

export class EmailProcessor extends StreamProcessor<
  EmailState,
  ConsumedEvent<typeof EmailContract>
> {
  readonly contract = EmailContract;

  override reduce({
    event,
    state,
  }: ReduceArgs<EmailState, ConsumedEvent<typeof EmailContract>>): EmailState | undefined {
    // Only the platform records mail (integrations/email.ts): a member's own append of these types
    // stays on the log and threads nothing.
    if (event.source?.platform !== true) return undefined;
    switch (event.type) {
      case "events.iterate.com/email/received":
      case "events.iterate.com/email/sent": {
        const { messageId, inReplyTo, references, subject } = event.payload;
        // A reply joins the thread of the message it answers, else of its nearest known ancestor
        // (References lists them oldest first); a message with none known here starts a thread.
        const threadOffset =
          [inReplyTo, ...references.toReversed()]
            .map((id) => (id ? state.threadOffsetByMessageId[id] : undefined))
            .find((offset) => offset !== undefined) ?? event.offset;
        const thread = state.threads[threadOffset] ?? { subject, messageOffsets: [] };
        return {
          threads: {
            ...state.threads,
            [threadOffset]: { ...thread, messageOffsets: [...thread.messageOffsets, event.offset] },
          },
          threadOffsetByMessageId: messageId
            ? { ...state.threadOffsetByMessageId, [messageId]: threadOffset }
            : state.threadOffsetByMessageId,
        };
      }
      default:
        return undefined;
    }
  }
}
