// itx.ts — the itx core. `Itx` IS a real StreamProcessor.
//
// `Itx extends StreamProcessor<ItxContract>` from the platform streams engine
// (apps/os/src/domains/streams/engine). We override exactly one pure method —
// `reduce` (the fold) — and add the verbs. Everything DURABLE (what names exist,
// each one's address) is the fold of the event log; the only non-durable state
// is the in-memory bridge of live stubs, which is precisely the live-vs-sturdy
// line drawn in running code.
//
// This file also holds the small shared vocabulary every itx implementation
// uses: the capability-descriptor types, path matching, `retain`, and
// `replayPath`. `GlobalContext` (global-context.ts) reuses them so the two
// implementations of the protocol cannot drift in how they resolve a path.

import { StreamProcessor } from "@iterate-com/os/src/domains/streams/engine/stream-processor.ts";
import { ItxContract, type CapabilityAddress, type CapabilityRecord } from "./contract.ts";

// ---------------------------------------------------------------------------
// The protocol every context answers, and the one capability-descriptor shape.
// ---------------------------------------------------------------------------

/**
 * The descriptor you pass to `provideCapability`, and the shape the constructor
 * takes for `builtinCapabilities`. A built-in is just a capability pre-provided
 * in code (handed to the constructor) instead of via an appended event.
 *
 * `capability` is either a live value (a function / nested object — held in the
 * bridge) or a sturdy `CapabilityAddress` (plain data — stored and re-dialed).
 */
export type ProvideArgs = {
  path: string[];
  capability: unknown;
  instructions?: string;
  types?: string;
};

/** What `describe()` returns: this context's folded capability table, its
 *  built-ins (which are not in the fold, so listed separately), and the parent
 *  context nested under `parentCapabilities` — recursively, up to the root. */
export type DescribeResult = {
  capabilities: CapabilityRecord[];
  builtins: CapabilityRecord[];
  parentCapabilities?: DescribeResult;
};

/**
 * The itx context protocol. A served context AND a dialable parent both answer
 * it. `Itx` and `GlobalContext` each `implements` this, so the two cannot drift
 * apart: change one method's shape and the other stops compiling.
 *
 * Every verb takes a single bag-of-props argument (no positional parameters) —
 * this is the one calling convention across the wire, the bridge, the chain and
 * codemode, so an adapter never has to translate between two shapes.
 */
export interface ItxContext {
  provideCapability(args: ProvideArgs): Promise<{ path: string[] }>;
  invokeCapability(args: { path: string[]; args?: unknown[] }): Promise<unknown>;
  revokeCapability(args: { path: string[] }): Promise<void>;
  describe(): Promise<DescribeResult>;
}

// ---------------------------------------------------------------------------
// Shared vocabulary.
// ---------------------------------------------------------------------------

/** Structural live-vs-sturdy test: a sturdy provided capability is plain
 *  `{ type: "rpc", … }` data; anything else (a function, a nested object) is a
 *  live stub. (Parent addresses use other `type`s and are never provided as
 *  capabilities, so this stays specific to `"rpc"`.) */
export const isCapabilityAddress = (c: unknown): c is CapabilityAddress =>
  !!c && typeof c === "object" && (c as { type?: unknown }).type === "rpc";

/** Project a live or sturdy `capability` into the `address` the table stores. */
const addressOf = (capability: unknown): CapabilityAddress | null =>
  isCapabilityAddress(capability) ? capability : null;

/**
 * Retain a live provider past the call that delivered it. Over Cap'n Web /
 * Workers RPC an argument stub is disposed when the call that received it
 * returns — so a live stub we intend to keep must be `dup()`'d to outlive that
 * call. A nested provider object crosses by value with its function members as
 * stubs, so we walk and dup each. In plain JS there is no `dup` and this is
 * identity. (Production calls this `retainLiveProvider`.) ONE definition, reused
 * by both the bridge here and the serving edge in server.ts.
 */
export function retain(target: any): any {
  if (target && typeof target.dup === "function") return target.dup();
  if (target && typeof target === "object") {
    const out: any = Array.isArray(target) ? [] : {};
    for (const k of Object.keys(target)) out[k] = retain(target[k]);
    return out;
  }
  return target;
}

/** Two capability paths are equal iff their segments match exactly. */
const samePath = (a: string[], b: string[]) =>
  a.length === b.length && a.every((seg, i) => seg === b[i]);

/** `prefix` is a prefix of `path` (so a cap mounted at `prefix` answers `path`). */
const isPrefixOf = (prefix: string[], path: string[]) =>
  prefix.length <= path.length && prefix.every((seg, i) => seg === path[i]);

/**
 * Longest-registered-prefix wins, so a deep shadow (`slack.chat.postMessage`)
 * beats a broad mount (`slack`). Returns the winning record and the leftover
 * path segments to replay on it. ALL matching is on path ARRAYS — there is no
 * dotted-string key anywhere in resolution.
 */
export function resolveLongestPrefix<T extends { path: string[] }>(caps: T[], path: string[]) {
  let best: { record: T; rest: string[] } | null = null;
  for (const record of caps) {
    if (isPrefixOf(record.path, path) && (!best || record.path.length > best.record.path.length)) {
      best = { record, rest: path.slice(record.path.length) };
    }
  }
  return best;
}

/**
 * Walk the leftover path segments on a resolved target, then call the leaf on
 * its receiver. `receiver[last](...args)` (not a detached `.apply`) matters: a
 * retained Cap'n Web member is a stub whose `.apply` is itself a path segment,
 * not a callable — the method must be invoked on its owning object.
 */
export async function replayPath(target: any, rest: string[], args: unknown[]) {
  if (rest.length === 0) return typeof target === "function" ? await target(...args) : target;
  let receiver = target;
  for (let i = 0; i < rest.length - 1; i++) receiver = receiver[rest[i]];
  return await receiver[rest.at(-1)!](...args);
}

// ---------------------------------------------------------------------------
// The core: Itx.
// ---------------------------------------------------------------------------

export class Itx extends StreamProcessor<typeof ItxContract> implements ItxContext {
  readonly contract = ItxContract;

  // The bridge: live stubs, keyed by the capability's path. In memory, NOT
  // durable — a live cap dies with its provider, which is exactly why the fold
  // records it with `address: null` while the real stub lives here. Keyed by the
  // path ARRAY (joined only as a Map key) to stay consistent with the fold.
  #liveCapabilities = new Map<string, any>();

  // Injected dialer: a sturdy ADDRESS → a callable stub. ONE dialer serves both
  // a capability's sturdy address AND a parent context's address — they are the
  // same operation, "address → stub". Optional: a context with only live caps
  // and no parent never needs it. (Production splits this into a gated capability
  // dial and an ungated context dial for the auth boundary; the reference impl is
  // unauthed within a connection, so one dial. Auth lives at the connect door.)
  #dial: (address: any) => any;

  // Built-in capabilities: the SAME `ProvideArgs` shape as a provide, but handed
  // to the constructor as an array instead of appended to the log (e.g. a project
  // context's `fetch`, backed by its Project DO). Own provides shadow a built-in
  // at the same path. Changing built-ins is a code change, not a log rewrite.
  #builtins: ProvideArgs[];

  // The chain: an Itx is born with a PARENT address (an agent's parent is its
  // project; a project's is the global root). On a capability MISS, resolution
  // falls through to the parent. The parent is a sturdy address — the same plain
  // data a capability uses — dialed by the same `#dial`. null when there is none.
  #parentAddress: any | null;

  constructor(
    args: ConstructorParameters<typeof StreamProcessor<typeof ItxContract>>[0] & {
      dial?: (address: any) => any;
      builtinCapabilities?: ProvideArgs[];
      parentAddress?: any;
    },
  ) {
    super(args);
    this.#dial =
      args.dial ??
      (() => {
        throw new Error("this context has no dial configured (no sturdy addresses or parent)");
      });
    this.#builtins = args.builtinCapabilities ?? [];
    this.#parentAddress = args.parentAddress ?? null;
  }

  // The fold: one pure projection of an event into the next capability table.
  // Returning the same state for events we do not consume is the identity case
  // (the codemode bracket events fall through here — they are records, not state).
  protected override reduce(args: Parameters<StreamProcessor<typeof ItxContract>["reduce"]>[0]) {
    const { event, state } = args as { event: any; state: any };
    switch (event.type) {
      case "events.iterate.com/itx/capability-provided": {
        const { path, address, instructions, types } = event.payload;
        const row: CapabilityRecord = {
          path,
          address: address ?? null,
          instructions: instructions ?? null,
          types: types ?? null,
        };
        // A provide at an existing path REPLACES that row in place; otherwise it
        // appends. The list is the capabilities in arrival order, deduped by path.
        const exists = state.capabilities.some((c: CapabilityRecord) => samePath(c.path, path));
        return {
          ...state,
          capabilities: exists
            ? state.capabilities.map((c: CapabilityRecord) => (samePath(c.path, path) ? row : c))
            : [...state.capabilities, row],
        };
      }
      case "events.iterate.com/itx/capability-revoked": {
        return {
          ...state,
          capabilities: state.capabilities.filter(
            (c: CapabilityRecord) => !samePath(c.path, event.payload.path),
          ),
        };
      }
      default:
        return state;
    }
  }

  // provide = append an event. A live stub also lands in the in-memory bridge.
  // There is NO self-ingest: the event flows out to the stream and the stream's
  // subscription delivers it back into the fold. We then wait for that delivery
  // so the write is immediately readable (read-your-writes).
  async provideCapability({ path, capability, instructions, types }: ProvideArgs) {
    const address = addressOf(capability);
    // dup at THIS layer too: the stub arrived as an argument to this call and is
    // disposed when the call returns; the bridge must keep its own retained copy.
    if (address === null) this.#liveCapabilities.set(path.join(" "), retain(capability));
    const committed = await this.ctx.stream.append({
      event: {
        type: "events.iterate.com/itx/capability-provided",
        payload: { path, address, instructions, types },
      },
    });
    await this.#awaitDelivered((committed as any).offset);
    return { path };
  }

  async revokeCapability({ path }: { path: string[] }) {
    this.#liveCapabilities.delete(path.join(" "));
    const committed = await this.ctx.stream.append({
      event: { type: "events.iterate.com/itx/capability-revoked", payload: { path } },
    });
    await this.#awaitDelivered((committed as any).offset);
  }

  // describe() is the ONE read verb (there is no separate `list`). It hands back
  // this context's RAW folded table, its constructor-injected `builtins`, and
  // nests the parent under `parentCapabilities` recursively to the root. Every
  // row — folded or built-in — is the same `CapabilityRecord` shape.
  async describe(): Promise<DescribeResult> {
    return {
      capabilities: this.state.capabilities,
      builtins: this.#builtins.map(builtinToRecord),
      ...(this.#parentAddress
        ? { parentCapabilities: await this.#dial(this.#parentAddress).describe() }
        : {}),
    };
  }

  // invoke resolves over the FOLD first (own caps win), then the built-ins, then
  // the parent. A live hit borrows its stub from the bridge; a sturdy hit dials
  // its address; either way the leftover path is replayed onto the result.
  async invokeCapability({ path, args = [] }: { path: string[]; args?: unknown[] }) {
    // 1. own capabilities (the fold) — longest prefix wins.
    const hit = resolveLongestPrefix(this.state.capabilities, path);
    if (hit) {
      if (hit.record.address === null) {
        const stub = this.#liveCapabilities.get(hit.record.path.join(" "));
        if (!stub) {
          throw new Error(
            `capability "${hit.record.path.join(".")}" is offline (live provider disconnected)`,
          );
        }
        return await replayPath(stub, hit.rest, args);
      }
      return await replayPath(this.#dial(hit.record.address), hit.rest, args);
    }
    // 2. built-ins — same longest-prefix match, over the array the host injected.
    const builtin = resolveLongestPrefix(this.#builtins, path);
    if (builtin) return await replayPath(builtin.record.capability, builtin.rest, args);
    // 3. the chain — on a miss, RE-DISPATCH the whole path into the parent's
    //    invokeCapability (recurse up the chain), so a child shadows by late
    //    binding (re-resolved per call), not by copy.
    if (this.#parentAddress) {
      return await this.#dial(this.#parentAddress).invokeCapability({ path, args });
    }
    throw new Error(`no capability "${path.join(".")}"`);
  }

  // Read-your-writes without self-ingest: after appending, wait for the stream's
  // subscription to deliver our own event back into the fold (the checkpoint
  // catches up to the appended offset). The stream is the single source of truth.
  //
  // TODO(deferred): this is a spin-poll on `checkpointOffset`. It works but is a
  // wart — replace with a proper "delivered to offset N" await once the streams
  // engine exposes one. Tracked as a known follow-up, not load-bearing design.
  async #awaitDelivered(offset: number): Promise<void> {
    for (let i = 0; i < 400 && this.checkpointOffset < offset; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

/** Project a built-in (`ProvideArgs`) into the `CapabilityRecord` describe()
 *  reports — built-ins are not in the fold, so we derive the row on read. */
function builtinToRecord(b: ProvideArgs): CapabilityRecord {
  return {
    path: b.path,
    address: addressOf(b.capability),
    instructions: b.instructions ?? null,
    types: b.types ?? null,
  };
}
