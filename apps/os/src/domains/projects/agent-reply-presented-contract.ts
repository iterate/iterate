// The `project/agent-reply-presented` claim event, as a STANDALONE event
// catalog — the same cycle-breaking arrangement as approval-presented-contract.ts:
// the project contract OWNS the event (it spreads this catalog into its
// `events`), while the device contract CONSUMES it through `processorDeps`,
// and the project contract already imports the device contract.

import { z } from "zod";

export const AgentReplyPresentedEvents = {
  "events.iterate.com/project/agent-reply-presented": {
    description:
      "A signed-in client is ALREADY SHOWING an agent's chat reply to the user (the mobile " +
      "thread screen and the web thread view append this when the reply renders foregrounded). " +
      "Purely a delivery hint: push channels holding a pending chat-reply notification for the " +
      "reply settle it suppressed instead of ringing a phone about something on screen. Claims " +
      "for unknown or already-sent notifications are no-ops, so clients append freely.",
    payloadSchema: z.strictObject({
      path: z
        .string()
        .startsWith("/agents/")
        .meta({ description: "The agent stream the presented reply lives on." }),
      replyEventOffset: z
        .number()
        .int()
        .positive()
        .meta({
          description:
            "The presented reply's identity on that stream: the offset of its " +
            "agents/web-message-sent event (offsets are per-stream, so path + offset " +
            "together are the identity).",
        }),
    }),
  },
};
