// stream-processor-durable-object.ts — THE SDK BASE CLASS a processor author extends. A processor IS
// a `DurableObject`: the author writes `reduce` / `processEvent` / `projectLiveState` on the class,
// and the platform hosts it as a FACET of its context through the ordinary
// `itx.load(src).getDurableObjectClass('Presence').get('presence')` — exactly the way any stateful
// class is hosted; a processor is a named facet that additionally gets pushed every commit.
//
// IDENTITY is `ctx.props` — `{ contextName, name }` minted by the parent at `getDurableObjectClass(C,
// { props })`, the only party that knows it (pinned in __workers-tests__/facet-props.test.ts). No
// configure() side channel, no identity kv. THE STREAM is `env.ITX` — the loaded isolate's binding to
// its owning context (itx-entrypoint.ts): `append`/`read` for the engine, `get()` for the scope.
//
// The engine — serial chain, checkpoint, gap repair from the scanned-range proof, the at-head pass,
// version refolds, live-state publishing — is stream/processor.ts's `StreamProcessor`, unchanged and
// Node-tested; this class is the DurableObject shell around one instance of it, ~a screen of wiring.
// Bundled into `processor.js` (build-sdk.mjs), so userspace imports it from "./processor.js".
//
// NEVER define alarm(): facets have none (workerd#6810); a timer, when one is needed, will be a
// scheduled append on the context, not an alarm here.

import { DurableObject } from "cloudflare:workers";
import {
  StreamProcessor,
  type ProcessEventArgs,
  type ProcessorContract,
  type ProcessorSnapshot,
  type ProcessorStream,
  type ReduceArgs,
  type ScannedRange,
} from "../stream/processor.ts";
import type { StreamEvent, StreamEventInput } from "../stream/events.ts";
import {
  DurableObjectNameCodec,
  type DurableObjectAddress,
} from "../context/durable-object-names.ts";

/** What the parent mints the class with — the whole identity. */
export type StreamProcessorProps = { contextName: string; name: string };

/** The `env.ITX` binding a loaded isolate holds (a stub of ItxEntrypoint): the stream verbs the
 *  engine drives, and `get()` — the owning context's itx scope, the same one a capnweb client holds. */
export type ItxBinding = {
  get(): Promise<unknown>;
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  read(
    afterOffset?: number,
    limit?: number,
  ): Promise<{ events: StreamEvent[]; scannedThroughOffset: number }>;
  fetch(request: Request): Promise<Response>;
};

export abstract class StreamProcessorDurableObject<
  State,
  Env extends { ITX: ItxBinding } = { ITX: ItxBinding },
> extends DurableObject<Env, StreamProcessorProps> {
  abstract readonly contract: ProcessorContract<State>;

  // ── the three hooks: the author surface ──

  /** Pure reduce. Return the NEXT state (a new object) — or null/undefined to keep the current. */
  protected reduce(_args: ReduceArgs<State>): State | null | undefined {
    return undefined;
  }
  /** Side effects. Synchronous by design: register async work via `blockProcessorWhile` /
   *  `runInBackground` on the args. */
  protected processEvent(_args: ProcessEventArgs<State>): undefined {}
  /** The live PROJECTION of the reduced state — what `liveSnapshot()` serves and what the deltas are
   *  diffed over. Default: the state verbatim. Override to trim, or to fold in runtime fields the
   *  reduce does not own; call `publishLiveState()` after such a field changes out of band. */
  protected projectLiveState(state: State): unknown {
    return state;
  }

  // ── what an author reaches ──

  /** The owning context's parsed address — `{ projectId, path, name }`, `name` its canonical codec
   *  string (the same object the context DO holds). From `ctx.props.contextName`. */
  protected readonly context: DurableObjectAddress = DurableObjectNameCodec.parse(
    this.ctx.props.contextName,
  );
  /** This processor's own name: the facet name, the subscription name, the `.get(name)` name. */
  protected readonly name: string = this.ctx.props.name;
  /** The owning context's itx scope — what a capnweb client holds, reached through `env.ITX`. */
  protected get itx(): Promise<unknown> {
    return this.env.ITX.get();
  }
  /** The stream this processor folds: the context's log through `env.ITX`. */
  protected get stream(): ProcessorStream {
    return {
      append: (...events) => this.env.ITX.append(...events),
      read: (after, limit) => this.env.ITX.read(after, limit),
    };
  }
  /** Emit a delta for the current projection if it changed (after a runtime field moved out of band). */
  protected publishLiveState(): void {
    this.#engine().publish();
  }
  /** `${slug}/${key}`, or with `whileProcessing` `${slug}/${key}@${path}:${offset}`. */
  protected idempotencyKey(key: string, whileProcessing?: StreamEvent): string {
    return this.#engine().idempotency(key, whileProcessing);
  }

  // ── the doors the delivery loop and `itx.facets.get(name)` reach ──

  /** THE push door: the context hands over each committed batch with its scanned-range proof. */
  processEventBatch(events: StreamEvent[], range: ScannedRange): Promise<void> {
    return this.#engine().processEventBatch(events, range);
  }
  /** Catch up from the log (the read-your-writes entry after an eviction). */
  wake(): Promise<void> {
    return this.#engine().wake();
  }
  /** Caught up through the log, then `{ offset, state }`. */
  snapshot(): Promise<ProcessorSnapshot<State>> {
    return this.#engine().snapshot();
  }
  /** The live-state seed door: `{ rev, state: projectLiveState(reduced) }`. */
  liveSnapshot(): Promise<{ rev: number; state: unknown }> {
    return this.#engine().liveSnapshot();
  }
  /** The barrier: resolves once processed at least through `offset` (default timeout 10s). */
  waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<void> {
    return this.#engine().waitUntilProcessed(input);
  }

  // ── the engine: one StreamProcessor whose hooks are this object's methods, built on first use
  // (`contract` is a subclass field — it does not exist yet while this class constructs) ──
  #built?: Engine<State>;
  #engine(): Engine<State> {
    return (this.#built ??= new Engine<State>(
      {
        contract: this.contract,
        reduce: (a) => this.reduce(a),
        processEvent: (a) => this.processEvent(a),
        projectLiveState: (s) => this.projectLiveState(s),
      },
      {
        stream: this.stream,
        storage: {
          get: <T>(k: string) => this.ctx.storage.kv.get(k) as T | undefined,
          put: (k: string, v: unknown) => this.ctx.storage.kv.put(k, v),
          delete: (k: string) => void this.ctx.storage.kv.delete(k),
        },
        path: this.context.path,
        projectId: this.context.projectId,
      },
    ));
  }
}

/** The engine with its hooks pointed at the hosting object. `publish`/`idempotency` re-export the
 *  two protected helpers the shell forwards. */
class Engine<State> extends StreamProcessor<State> {
  readonly contract: ProcessorContract<State>;
  readonly #hooks: {
    reduce: (a: ReduceArgs<State>) => State | null | undefined;
    processEvent: (a: ProcessEventArgs<State>) => undefined;
    projectLiveState: (s: State) => unknown;
  };
  constructor(
    hooks: { contract: ProcessorContract<State> } & Engine<State>["hooksType"],
    args: ConstructorParameters<typeof StreamProcessor<State>>[0],
  ) {
    super(args);
    this.contract = hooks.contract;
    this.#hooks = hooks;
  }
  declare readonly hooksType: {
    reduce: (a: ReduceArgs<State>) => State | null | undefined;
    processEvent: (a: ProcessEventArgs<State>) => undefined;
    projectLiveState: (s: State) => unknown;
  };
  protected override reduce(args: ReduceArgs<State>): State | null | undefined {
    return this.#hooks.reduce(args);
  }
  protected override processEvent(args: ProcessEventArgs<State>): undefined {
    return this.#hooks.processEvent(args);
  }
  protected override liveState(state: State): unknown {
    return this.#hooks.projectLiveState(state);
  }
  publish(): void {
    this.publishLiveState();
  }
  idempotency(key: string, whileProcessing?: StreamEvent): string {
    return this.idempotencyKey(key, whileProcessing);
  }
}
