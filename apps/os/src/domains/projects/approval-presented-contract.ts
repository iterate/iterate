// The `project/approval-presented` claim event, as a STANDALONE event catalog
// (see processor-contracts.ts: a `processorDeps` entry may be a catalog rather
// than a full contract). It lives in its own module because two contracts need
// the one schema and they cannot import each other: the project contract OWNS
// the event (it spreads this catalog into its `events`, so the root stream's
// vocabulary and the docs site list it under the project processor), while the
// device contract CONSUMES it through `processorDeps` — and the project
// contract already imports the device contract, so the device contract
// importing the project contract back would be a cycle.

import { z } from "zod";

export const APPROVAL_PRESENTED_EVENT_TYPE = "events.iterate.com/project/approval-presented";

export const ApprovalPresentedEvents = {
  [APPROVAL_PRESENTED_EVENT_TYPE]: {
    description:
      "A signed-in client is ALREADY SHOWING a held approval batch to the user (the mobile " +
      "in-thread dialog appends this when it renders foregrounded). Purely a delivery hint, " +
      "never a decision: push channels holding a pending notification for the batch settle it " +
      "suppressed instead of ringing a phone about something on screen. Claims for unknown or " +
      "already-sent notifications are no-ops, so clients append freely.",
    payloadSchema: z.strictObject({
      approvalRequestEventOffset: z
        .number()
        .int()
        .positive()
        .meta({
          description:
            "The presented batch's identity: the offset of its project/human-approval-requested " +
            "event on the project root stream — the only identity a client sees (device-stream " +
            "offsets never leave the platform).",
        }),
    }),
  },
};
