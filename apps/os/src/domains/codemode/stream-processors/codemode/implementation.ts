// Implements the "codemode" processor as a class-based StreamProcessor, hosted
// by the CodemodeSession Durable Object. Ported from
// packages/shared/src/stream-processors/codemode/implementation.ts.
//
// What the processor still does: reduce codemode telemetry into state, append
// `session-started` once (publishing the session capability callable), and run
// requested scripts, appending `script-execution-completed` / `log-emitted`
// with the same idempotency keys as the legacy implementation.
//
// What was deliberately NOT ported: the legacy implementation's internal
// session/callFunction machinery (tool-provider resolution, builtins,
// event-mediated waits, dispatchCallable). In the OS wiring that code was dead:
// the Cloudflare script executor was always built with `getSessionCapability`
// pointing at the CodemodeSession DO, so every ctx.* call from a script goes
// through CodemodeSession.callFunction, which owns that protocol.
//
// Side-effect semantics (mirrors the legacy OS runner, which adapted this
// processor with `detachedSideEffects: true`):
// - `session-started` blocks the checkpoint (`blockProcessorWhile`), like the
//   old awaited `ensureSessionStarted`;
// - script execution runs detached (`runInBackground`, the old `keepAlive`):
//   scripts call back into CodemodeSession.callFunction, which appends
//   function-call events and waits for THIS processor to reduce them — blocking
//   the checkpoint on script completion would stall those waits.

import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import {
  assertNever,
  buildProcessorIdempotencyKey,
  type ConsumedEvent,
} from "@iterate-com/streams/shared/stream-processors";
// Callable is only needed as a type here; the zod schema lives in the contract.
import type { Callable } from "@iterate-com/shared/callable/types.ts";
import {
  CodemodeProcessorContract,
  toolProviderRegistryKey,
  type CodemodeState,
} from "./contract.ts";
import type {
  CodemodeProcessorLogger,
  CodemodeProcessorSession,
  CodemodeScriptExecutor,
} from "./code-executor.ts";

export { CodemodeProcessorContract, toolProviderRegistryKey } from "./contract.ts";

export type CodemodeProcessorContract = typeof CodemodeProcessorContract;

type CodemodeConsumedEvent = ConsumedEvent<CodemodeProcessorContract>;
type ScriptExecutionRequestedEvent = Extract<
  CodemodeConsumedEvent,
  { type: "events.iterate.com/codemode/script-execution-requested" }
>;

/**
 * Input shape for RPC tool-provider callables dispatched on behalf of codemode
 * function calls. Wire-compatible with the legacy
 * `@iterate-com/shared/stream-processors/codemode/implementation` export.
 */
export type ExecuteCodemodeFunctionCallInput = {
  args: unknown[];
  codemodeSessionCapability: CodemodeProcessorSession;
  functionCallId: string;
  functionPath: string[];
  invocationKind: "rpc";
  path: string[];
  providerPath: string[];
  scriptExecutionId?: string;
};

export type CodemodeProcessorDeps = {
  /** Published on `session-started` so event-mediated providers can dial back. */
  buildSessionCapabilityCallable: () => Callable;
  /** The session capability handed to executing scripts (ctx.* call protocol). */
  getSessionCapability: () => CodemodeProcessorSession | Promise<CodemodeProcessorSession>;
  now?: () => Date;
  scriptExecutor: CodemodeScriptExecutor;
};

export class CodemodeProcessor extends StreamProcessor<
  CodemodeProcessorContract,
  CodemodeProcessorDeps
> {
  readonly contract = CodemodeProcessorContract;

  /**
   * In-flight (or settled-successful) session-started append. Memoized so the
   * batch gate and any concurrently-starting script await one append; the
   * stream-side idempotency key is the real once-only guarantee.
   */
  #sessionStartedAppend: Promise<unknown> | undefined;

  protected override reduce(
    args: Parameters<StreamProcessor<CodemodeProcessorContract>["reduce"]>[0],
  ): CodemodeState {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/codemode/log-emitted":
        return state;
      case "events.iterate.com/codemode/session-started":
        return {
          ...state,
          sessionCapabilityCallable: event.payload.sessionCapabilityCallable,
          sessionStarted: true,
        };
      case "events.iterate.com/codemode/tool-provider-registered":
        return {
          ...state,
          toolProviders: {
            ...state.toolProviders,
            [toolProviderRegistryKey(event.payload.path)]: event.payload,
          },
        };
      case "events.iterate.com/codemode/vars-updated":
        return {
          ...state,
          vars: {
            ...state.vars,
            ...event.payload.vars,
          },
        };
      case "events.iterate.com/codemode/script-execution-requested":
        return {
          ...state,
          scriptExecutions: {
            ...state.scriptExecutions,
            [event.payload.scriptExecutionId]: {
              status: "requested" as const,
              code: event.payload.code,
              scriptExecutionId: event.payload.scriptExecutionId,
            },
          },
        };
      case "events.iterate.com/codemode/script-execution-completed":
        return {
          ...state,
          scriptExecutions: {
            ...state.scriptExecutions,
            [event.payload.scriptExecutionId]: {
              status: "completed" as const,
              ...(event.payload.durationMs == null ? {} : { durationMs: event.payload.durationMs }),
              outcome: event.payload.outcome,
              scriptExecutionId: event.payload.scriptExecutionId,
            },
          },
        };
      case "events.iterate.com/codemode/function-call-requested":
        return {
          ...state,
          functionCalls: {
            ...state.functionCalls,
            [event.payload.functionCallId]: {
              status: "requested" as const,
              args: event.payload.args,
              functionCallId: event.payload.functionCallId,
              functionPath: event.payload.functionPath,
              invocationKind: event.payload.invocationKind,
              path: event.payload.path,
              providerPath: event.payload.providerPath,
              ...(event.payload.scriptExecutionId == null
                ? {}
                : { scriptExecutionId: event.payload.scriptExecutionId }),
            },
          },
        };
      case "events.iterate.com/codemode/function-call-completed":
        return {
          ...state,
          functionCalls: {
            ...state.functionCalls,
            [event.payload.functionCallId]: {
              status: "completed" as const,
              ...(event.payload.durationMs == null ? {} : { durationMs: event.payload.durationMs }),
              functionCallId: event.payload.functionCallId,
              functionPath: event.payload.functionPath,
              invocationKind: event.payload.invocationKind,
              outcome: event.payload.outcome,
              path: event.payload.path,
              providerPath: event.payload.providerPath,
              ...(event.payload.scriptExecutionId == null
                ? {}
                : { scriptExecutionId: event.payload.scriptExecutionId }),
            },
          },
        };
      default:
        return assertNever(event);
    }
  }

  protected override async processEventBatch(
    args: Parameters<StreamProcessor<CodemodeProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    // The legacy implementation awaited ensureSessionStarted before every live
    // afterAppend. Equivalent here: any live consumed event on a stream whose
    // reduced state has not seen session-started holds the checkpoint until the
    // (idempotency-keyed) session-started append lands.
    const hasLiveEvents = args.reducedEvents.some(
      (reducedEvent) => reducedEvent.event.offset > args.sideEffectsAfterOffset,
    );
    if (hasLiveEvents && !args.state.sessionStarted) {
      args.blockProcessorWhile(() => this.#ensureSessionStarted());
    }
    await super.processEventBatch(args);
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<CodemodeProcessorContract>["processEvent"]>[0],
  ): void {
    if (args.event.type !== "events.iterate.com/codemode/script-execution-requested") return;
    const event = args.event;
    // Script-time inputs come from the reduced state at this event, exactly as
    // the legacy afterAppend received them.
    const sessionStarted = args.state.sessionStarted;
    const vars = args.state.vars;
    args.runInBackground(() => this.#executeRequestedScript({ event, sessionStarted, vars }));
  }

  #ensureSessionStarted(): Promise<unknown> {
    this.#sessionStartedAppend ??= Promise.resolve(
      this.ctx.stream.append({
        event: {
          type: "events.iterate.com/codemode/session-started",
          idempotencyKey: "events.iterate.com/codemode/session-started",
          payload: {
            sessionCapabilityCallable: this.deps.buildSessionCapabilityCallable(),
          },
        },
      }),
    ).catch((error: unknown) => {
      // Clear the memo so a later batch retries the append.
      this.#sessionStartedAppend = undefined;
      throw error;
    });
    return this.#sessionStartedAppend;
  }

  async #executeRequestedScript(args: {
    event: ScriptExecutionRequestedEvent;
    sessionStarted: boolean;
    vars: Record<string, string>;
  }): Promise<void> {
    // Keep the legacy ordering: session-started (and its capability callable)
    // is on the stream before the script starts calling providers.
    if (!args.sessionStarted) await this.#ensureSessionStarted();

    const now = this.deps.now ?? (() => new Date());
    const startedAt = now();
    const scriptExecutionId = args.event.payload.scriptExecutionId;
    const logger = this.#createScriptLogger({ scriptExecutionId, sourceEvent: args.event });

    let result: Awaited<ReturnType<CodemodeScriptExecutor>>;
    try {
      result = await this.deps.scriptExecutor({
        code: args.event.payload.code,
        logger,
        scriptExecutionId,
        session: await this.deps.getSessionCapability(),
        // The legacy runner created a fresh AbortController per afterAppend and
        // never aborted it; preserved until script cancellation exists.
        signal: new AbortController().signal,
        vars: args.vars,
      });
    } catch (error) {
      result = { result: undefined, error: serializeError(error) };
    }

    const finishedAt = now();
    await this.ctx.stream.append({
      event: {
        type: "events.iterate.com/codemode/script-execution-completed",
        idempotencyKey: buildProcessorIdempotencyKey({
          processor: this.contract,
          key: "script-execution-completed",
          sourceEvent: args.event,
        }),
        payload: {
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          outcome:
            result.error == null
              ? { status: "returned" as const, value: result.result }
              : { status: "threw" as const, error: result.error },
          scriptExecutionId,
        },
      },
    });
  }

  #createScriptLogger(args: {
    scriptExecutionId: string;
    sourceEvent: { offset: number };
  }): CodemodeProcessorLogger {
    let logSequence = 0;
    return {
      log: async (level, message) => {
        logSequence += 1;
        await this.ctx.stream.append({
          event: {
            type: "events.iterate.com/codemode/log-emitted",
            idempotencyKey: buildProcessorIdempotencyKey({
              processor: this.contract,
              key: `log-emitted/${logSequence}`,
              sourceEvent: args.sourceEvent,
            }),
            payload: {
              level,
              message,
              scriptExecutionId: args.scriptExecutionId,
            },
          },
        });
      },
    };
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}
