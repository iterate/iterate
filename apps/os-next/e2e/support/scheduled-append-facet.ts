/** Executable userspace example: ordinary facet RPC configures timers; its processor reduces the
 *  resulting durable events. No alarm handler, platform binding, or polling timer is needed. */
export const scheduledAppendFacetSource = {
  "cap.js": `import { StreamProcessor, StreamProcessorDurableObject } from "./processor.js";
class Deadlines extends StreamProcessor {
  contract = {
    slug: "deadlines", version: "1", consumes: ["job/timed-out", "job/timeout-audit"], emits: [],
    initialState: () => ({ timedOut: [], audited: [] }),
  };
  reduce({ event, state }) {
    if (event.type === "job/timed-out") return { ...state, timedOut: [...state.timedOut, event.payload.job] };
    return { ...state, audited: [...state.audited, event.payload.job] };
  }
}
export class DeadlinesDurableObject extends StreamProcessorDurableObject {
  processor = new Deadlines();
  hasAlarmHandler() { return typeof this.alarm === "function"; }
  async start(job, at) {
    const itx = await this.env.ITX.get();
    try {
      return await itx.schedules.set({
        key: "deadline:" + job,
        when: { at },
        events: [
          { type: "job/timed-out", payload: { job } },
          { type: "job/timeout-audit", payload: { job } },
        ],
      });
    } finally { itx[Symbol.dispose](); }
  }
  async finish(job, scheduledAtOffset) {
    const itx = await this.env.ITX.get();
    try { return await itx.schedules.cancel("deadline:" + job, scheduledAtOffset); }
    finally { itx[Symbol.dispose](); }
  }
}`,
};

/** A pure processor emits scheduling intent with the same durable append API as business facts. */
export const scheduledAppendProcessorSource = {
  "cap.js": `import { StreamProcessor, StreamProcessorDurableObject } from "./processor.js";
class Reminders extends StreamProcessor {
  contract = {
    slug: "reminders", version: "1", consumes: ["invoice/opened", "invoice/reminder-due"],
    emits: ["events.iterate.com/stream/append-scheduled"],
    initialState: () => ({ reminded: [] }),
  };
  reduce({ event, state }) {
    if (event.type === "invoice/reminder-due") return { reminded: [...state.reminded, event.payload.invoiceId] };
  }
  processEvent({ event, append, blockProcessorWhile }) {
    if (event?.type !== "invoice/opened") return;
    blockProcessorWhile(() => append({
      type: "events.iterate.com/stream/append-scheduled",
      idempotencyKey: this.idempotencyKey("reminder", event),
      payload: {
        key: "invoice:" + event.payload.invoiceId,
        when: { at: new Date(Date.parse(event.createdAt) + 1500).toISOString() },
        events: [{ type: "invoice/reminder-due", payload: { invoiceId: event.payload.invoiceId } }],
      },
    }));
  }
}
export class RemindersDurableObject extends StreamProcessorDurableObject {
  processor = new Reminders();
}`,
};
