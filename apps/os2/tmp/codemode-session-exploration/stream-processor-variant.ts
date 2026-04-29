/**
 * More radical future variant: CodemodeSession as a pure stream processor.
 *
 * In this model, RPC methods are convenience appenders only. The session reacts
 * to stream events and appends derived events. This is not the first slice, but
 * it is the direction the current API should not block.
 */

type Event = {
  streamPath: string;
  type: string;
  offset: number;
  payload: Record<string, unknown>;
};

type EventInput = {
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
};

type Append = (event: EventInput) => Promise<Event>;

type CodemodeProcessorState = {
  providerRegistry: Record<string, unknown>;
  runningScriptExecutions: Record<number, { code: string }>;
};

export const codemodeProcessor = {
  initialState(): CodemodeProcessorState {
    return {
      providerRegistry: {},
      runningScriptExecutions: {},
    };
  },

  reduce(state: CodemodeProcessorState, event: Event) {
    if (event.type === "events.iterate.com/codemode/tool-provider-registered") {
      const path = event.payload.path;
      if (Array.isArray(path) && path.every((segment) => typeof segment === "string")) {
        state.providerRegistry[path.join("/")] = event.payload.descriptor;
      }
    }

    if (event.type === "events.iterate.com/codemode/script-execution-requested") {
      state.runningScriptExecutions[event.offset] = {
        code: String(event.payload.code ?? ""),
      };
    }

    if (
      event.type === "events.iterate.com/codemode/script-execution-succeeded" ||
      event.type === "events.iterate.com/codemode/script-execution-failed"
    ) {
      const requestedOffset = event.payload.scriptExecutionRequestedOffset;
      if (typeof requestedOffset === "number") {
        delete state.runningScriptExecutions[requestedOffset];
      }
    }
  },

  async afterAppend(args: { event: Event; append: Append; state: CodemodeProcessorState }) {
    if (args.event.type !== "events.iterate.com/codemode/script-execution-requested") {
      return;
    }

    // Future shape:
    // - run dynamic worker
    // - pass CodemodeSessionCapability
    // - append terminal event
    await args.append({
      type: "events.iterate.com/codemode/script-execution-succeeded",
      payload: {
        scriptExecutionRequestedOffset: args.event.offset,
        result: {
          placeholder: "This is where dynamic worker output would land.",
        },
      },
      idempotencyKey: `script-execution-terminal:${args.event.offset}`,
    });
  },
};

/**
 * If we adopt this version later, `executeScript()` collapses to:
 *
 *   append(script-execution-requested)
 *
 * and execution happens because the session processor observes the event. That
 * is cleaner, but it requires a robust "wake the session on append" mechanism
 * and a durable last-processed offset story.
 */
