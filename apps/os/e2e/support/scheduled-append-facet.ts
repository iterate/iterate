/** Executable userspace example: ordinary facet RPC configures timers; its processor reduces the
 *  resulting durable events. No alarm handler, platform binding, or polling timer is needed. */
export const scheduledAppendFacetSource = {
  "cap.js": `import { StreamProcessor, StreamProcessorDurableObject } from "./processor.js";
class Deadlines extends StreamProcessor {
  constructor(owner) { super(); this.owner = owner; }
  contract = {
    slug: "deadlines", version: "1", consumes: ["job/timed-out", "job/timeout-audit"], emits: [],
    initialState: () => ({ timedOut: [], audited: [] }),
  };
  reduce({ event, state }) {
    if (event.payload.owner !== this.owner) return;
    if (event.type === "job/timed-out") return { ...state, timedOut: [...state.timedOut, event.payload.job] };
    return { ...state, audited: [...state.audited, event.payload.job] };
  }
}
export class DeadlinesDurableObject extends StreamProcessorDurableObject {
  static publicMethods = [...super.publicMethods, "hasAlarmHandler", "start", "finish"];
  processor = new Deadlines(this.ctx.props.name);
  hasAlarmHandler() { return typeof this.alarm === "function"; }
  async start(job, when) {
    const itx = await this.env.ITX.get();
    try {
      return await itx.schedules.set({
        key: [this.ctx.props.name, job],
        when,
        events: [
          { type: "job/timed-out", payload: { job, owner: this.ctx.props.name } },
          { type: "job/timeout-audit", payload: { job, owner: this.ctx.props.name } },
        ],
      });
    } finally { itx[Symbol.dispose](); }
  }
  async finish(receipt) {
    const itx = await this.env.ITX.get();
    try { return await itx.schedules.cancel(receipt); }
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
        when: { afterMs: 1500 },
        events: [{ type: "invoice/reminder-due", payload: { invoiceId: event.payload.invoiceId } }],
      },
    }));
  }
}
export class RemindersDurableObject extends StreamProcessorDurableObject {
  processor = new Reminders();
}`,
};
