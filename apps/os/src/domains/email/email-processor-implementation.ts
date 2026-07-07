// Implements the "email" thread-router processor on itx
// (tasks/email-agent-zero-onboarding.md). Modeled on the Slack router
// (slack-processor-implementation.ts): route, record, forward — never
// interpret mail as agent input (that is the email-agent processor's job).

import { StreamProcessor } from "../streams/stream-processor.ts";
import type { StreamEventInput } from "../../types.ts";
import { emailThreadStreamPath, normalizeMessageId } from "./utils.ts";
import { EmailProcessorContract, type EmailProcessorState } from "./email-processor-contract.ts";

export class EmailProcessor extends StreamProcessor<typeof EmailProcessorContract> {
  readonly contract = EmailProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof EmailProcessorContract>["reduce"]>[0]): EmailProcessorState {
    switch (event.type) {
      case "events.iterate.com/email/thread-route-configured": {
        const threads = { ...state.threads };
        for (const messageId of event.payload.messageIds) {
          threads[normalizeMessageId(messageId)] = event.payload.streamPath;
        }
        return { ...state, threads };
      }
      case "events.iterate.com/email/sent": {
        // An outbound reply joins the thread of whatever it answered, so a
        // human replying to OUR mail (their In-Reply-To names our platform-
        // generated Message-ID) routes back to the same agent stream.
        if (typeof event.payload.messageId !== "string") return state;
        const streamPath = lookupThread(state, [
          event.payload.inReplyTo,
          ...(event.payload.references ?? []),
        ]);
        if (streamPath === undefined) return state;
        return {
          ...state,
          threads: { ...state.threads, [normalizeMessageId(event.payload.messageId)]: streamPath },
        };
      }
      case "events.iterate.com/email/received": {
        // The routing decision lives HERE, in the pure fold — not only in
        // processEvent — so two related emails landing in one delivery batch
        // stay consistent (the second sees the first's mapping in state
        // before any emitted route event round-trips through the stream).
        const streamPath = resolveThreadPath(state, event.payload);
        if (streamPath === undefined) return state;
        return {
          ...state,
          threads: { ...state.threads, [normalizeMessageId(event.payload.messageId)]: streamPath },
        };
      }
      default:
        return state;
    }
  }

  protected override processEvent({
    append,
    blockProcessorWhile,
    event,
    state,
  }: Parameters<StreamProcessor<typeof EmailProcessorContract>["processEvent"]>[0]): undefined {
    if (event.type !== "events.iterate.com/email/received") return;

    const payload = event.payload;
    // reduce() already resolved this message's thread into state; a miss means
    // it decided to drop (project-addressed mail outside any known thread —
    // the sibling task's project-inbox lane,
    // tasks/os-agent-email-cloudflare-workers.md). Drop, but loudly.
    const streamPath = state.threads[normalizeMessageId(payload.messageId)];
    if (streamPath === undefined) {
      console.warn(
        `[email] dropping project-addressed mail outside any known thread (message ${payload.messageId})`,
      );
      return;
    }

    /**
     * The route event stays on `/integrations/email`. It is router state:
     * "when a future email references this Message-ID, forward it to this
     * stream path." Recorded for every inbound message (not just thread
     * roots), so replies to any message in the conversation route.
     */
    const routeEvent = {
      type: "events.iterate.com/email/thread-route-configured" as const,
      idempotencyKey: `email-route:${normalizeMessageId(payload.messageId)}`,
      payload: {
        messageIds: [payload.messageId],
        streamPath,
      },
    };

    const forwardedEmailEvent: StreamEventInput = {
      type: "events.iterate.com/email/received",
      idempotencyKey: `email:forward-received:${event.offset}`,
      payload,
    };

    // Durable obligation, NOT best-effort: this forward is the only copy of
    // the email on its way to the agent (same reasoning as the Slack router's
    // blockProcessorWhile forwards — a fire-and-forget append that throws once
    // loses the message). Idempotency keys make the replay dedupe.
    blockProcessorWhile(async () => {
      await append(routeEvent);
      await this.stream.at(streamPath).append(forwardedEmailEvent);
    });
  }
}

/** First match wins: In-Reply-To is the direct parent, references are ancestry. */
function lookupThread(
  state: EmailProcessorState,
  messageIds: (string | undefined)[],
): string | undefined {
  for (const messageId of messageIds) {
    if (!messageId) continue;
    const path = state.threads[normalizeMessageId(messageId)];
    if (path !== undefined) return path;
  }
  return undefined;
}

/**
 * Where one inbound email belongs. Known ancestry (recorded inbound ids or
 * our own outbound ids) wins; otherwise the path derives deterministically
 * from the thread ROOT — `references[0]` when the client preserved the chain,
 * else the message's own id. Project-addressed mail gets no fresh threads
 * (undefined = drop): only the bot inbox may open a conversation until the
 * sibling project-inbox task ships.
 */
function resolveThreadPath(
  state: EmailProcessorState,
  payload: {
    inReplyTo?: string;
    messageId: string;
    recipient: { kind: "zero-onboarding" | "project" };
    references: string[];
  },
): string | undefined {
  const existing = lookupThread(state, [payload.inReplyTo, ...payload.references]);
  if (existing !== undefined) return existing;
  if (payload.recipient.kind === "project") return undefined;
  return emailThreadStreamPath(payload.references[0] ?? payload.inReplyTo ?? payload.messageId);
}
