// Implements the "email" thread-router processor on itx, shaped after the
// Slack webhook router (slack-processor-implementation.ts). Emitted event
// types, payloads, and idempotency keys are stable wire formats.

import { StreamProcessor } from "../streams/stream-processor.ts";
import type { StreamEventInput } from "../../types.ts";
import {
  EmailProcessorContract,
  type EmailProcessorState,
  type InboundEmailPayload,
} from "./email-processor-contract.ts";
import { emailAgentPath, normalizeMessageId } from "./utils.ts";

/** Where one inbound email belongs: an existing thread or a brand-new one. */
type EmailThreadResolution = {
  isNew: boolean;
  streamPath: string;
  threadId: string;
};

/**
 * Resolve the thread for one received email against router state, in fallback
 * order:
 *
 * 1. The recipient's `+t<threadId>` tag, when it names a thread we know. An
 *    unknown tag falls through — it routes by headers or starts a new thread
 *    instead of minting an attacker-chosen thread id.
 * 2. In-Reply-To, then References, against the message-id index. This catches
 *    replies sent to the bare project address.
 * 3. A new thread whose id is the received event's offset on
 *    `/integrations/email` — deterministic, unique per project, replay-safe.
 *
 * Shared by `reduce` (folding the index) and `processEvent` (forwarding), so
 * the fold and the forward can never disagree.
 */
function resolveEmailThread(input: {
  offset: number;
  payload: InboundEmailPayload;
  state: EmailProcessorState;
}): EmailThreadResolution {
  const { offset, payload, state } = input;

  const tagged = payload.recipient.threadId;
  if (tagged !== null) {
    const streamPath = state.threads[tagged];
    if (streamPath !== undefined) return { isNew: false, streamPath, threadId: tagged };
  }

  const headerIds = [payload.message.inReplyTo, ...payload.message.references]
    .map((id) => normalizeMessageId(id))
    .filter((id): id is string => id !== null);
  for (const id of headerIds) {
    const threadId = state.threadByMessageId[id];
    const streamPath = threadId === undefined ? undefined : state.threads[threadId];
    if (threadId !== undefined && streamPath !== undefined) {
      return { isNew: false, streamPath, threadId };
    }
  }

  const threadId = String(offset);
  return { isNew: true, streamPath: emailAgentPath(threadId), threadId };
}

export class EmailProcessor extends StreamProcessor<typeof EmailProcessorContract> {
  readonly contract = EmailProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof EmailProcessorContract>["reduce"]>[0]): EmailProcessorState {
    switch (event.type) {
      case "events.iterate.com/email/received": {
        const resolution = resolveEmailThread({
          offset: event.offset,
          payload: event.payload,
          state,
        });
        const messageId = normalizeMessageId(event.payload.message.messageId);
        return {
          ...state,
          threads: { ...state.threads, [resolution.threadId]: resolution.streamPath },
          threadByMessageId:
            messageId === null
              ? state.threadByMessageId
              : { ...state.threadByMessageId, [messageId]: resolution.threadId },
        };
      }
      case "events.iterate.com/email/sender-allowed": {
        const pattern = event.payload.pattern.trim().toLowerCase();
        if (pattern.length === 0 || state.allowedSenders.includes(pattern)) return state;
        return { ...state, allowedSenders: [...state.allowedSenders, pattern] };
      }
      case "events.iterate.com/email/sent": {
        // Outbound mail sent inside a thread: index its messageId so replies
        // to the agent's own messages route back without the +t tag.
        const threadId = event.payload.threadId;
        const messageId = normalizeMessageId(event.payload.messageId);
        if (threadId === undefined || messageId === null) return state;
        return {
          ...state,
          threadByMessageId: { ...state.threadByMessageId, [messageId]: threadId },
        };
      }
      case "events.iterate.com/email/thread-route-configured":
        return {
          ...state,
          threads: { ...state.threads, [event.payload.threadId]: event.payload.streamPath },
        };
      default:
        return state;
    }
  }

  protected override processEvent({
    append,
    blockProcessorWhile,
    event,
    previousState,
  }: Parameters<StreamProcessor<typeof EmailProcessorContract>["processEvent"]>[0]): undefined {
    if (event.type !== "events.iterate.com/email/received") return;

    // Resolve against the state BEFORE this event — the same input reduce()
    // folded — so forward target and fold always agree.
    const resolution = resolveEmailThread({
      offset: event.offset,
      payload: event.payload,
      state: previousState,
    });

    const forwardedEvent: StreamEventInput = {
      type: "events.iterate.com/email/received",
      idempotencyKey: `email:forward-received:${event.offset}`,
      payload: event.payload,
    };

    if (resolution.isNew) {
      const routeEvent = {
        type: "events.iterate.com/email/thread-route-configured" as const,
        idempotencyKey: `email-route:${resolution.threadId}`,
        payload: {
          threadId: resolution.threadId,
          streamPath: resolution.streamPath,
          ...(event.payload.message.from.address === undefined
            ? {}
            : { counterpart: event.payload.message.from.address }),
          ...(event.payload.message.subject === undefined
            ? {}
            : { subject: event.payload.message.subject }),
        },
      };
      // Durable obligation, NOT best-effort: this forward is the only copy of
      // the email on its way to the agent (same reasoning as the Slack
      // router's forward — a fire-and-forget append once lost a message for
      // good). blockProcessorWhile holds the checkpoint so a failed append
      // replays; idempotency keys make the replay dedupe.
      blockProcessorWhile(async () => {
        await append(routeEvent);
        await this.stream.at(resolution.streamPath).append(routeEvent, forwardedEvent);
      });
      return;
    }

    // Durable obligation — same reasoning as the route-creation forward above.
    blockProcessorWhile(async () => {
      await this.stream.at(resolution.streamPath).append(forwardedEvent);
    });
  }
}
