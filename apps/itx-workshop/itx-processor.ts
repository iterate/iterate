// itx-processor.ts — Itx IS a real StreamProcessor.
//
// This is Step 11 for real: `Itx extends StreamProcessor<ItxContract>` from the
// actual `@iterate-com/streams` package. We override exactly one pure method,
// `reduce` (the fold), and add the two verbs (`provideCapability` / `invoke`)
// plus revoke. Everything durable — what names exist, each one's kind and
// address — is the fold of the event log; the only non-durable state is the
// in-memory bridge of live stubs, which is precisely the live-vs-sturdy line.
//
// Root capabilities are NOT built in. There is no special handle carrying
// `fetch`/`streams`/etc. — whoever sets up a context just calls
// `provideCapability(...)`, the same verb used for everything else. (A context
// that should have defaults from birth can be handed them at construction and
// provide them in its setup; that's a convenience, not a separate mechanism.)

import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import { ITX_EVENTS, ItxContract } from "./itx-contract.ts";

/** Structural live-vs-sturdy discriminator: a sturdy address is plain `{ type: "rpc", … }` data. */
const isCapabilityAddress = (c: any): boolean => !!c && typeof c === "object" && c.type === "rpc";

/** The longest registered path-prefix wins (so a deep shadow beats a broad mount). */
function resolveLongestPrefix(caps: Record<string, any>, path: string[]) {
  for (let i = path.length; i >= 1; i--) {
    const name = path.slice(0, i).join(".");
    if (caps[name]) return { name, record: caps[name], rest: path.slice(i) };
  }
  return null;
}

/** Walk the remainder of the path on the resolved target, then call the leaf on its receiver. */
async function replayPath(target: any, rest: string[], args: unknown[]) {
  if (rest.length === 0) return typeof target === "function" ? await target(...args) : target;
  let receiver = target;
  for (let i = 0; i < rest.length - 1; i++) receiver = receiver[rest[i]];
  return await receiver[rest.at(-1)!](...args);
}

export class Itx extends StreamProcessor<typeof ItxContract> {
  readonly contract = ItxContract;

  // The Step-4 bridge: name → live stub. In memory, NOT durable — a live cap
  // dies with its provider, which is exactly why the fold records it with
  // address: null and the actual stub lives here beside the fold.
  #live = new Map<string, any>();

  // Injected restorer for sturdy addresses (Step 9's dial). Optional: a context
  // with only live caps never needs it.
  #dial: (address: any) => any;

  constructor(
    args: ConstructorParameters<typeof StreamProcessor<typeof ItxContract>>[0] & {
      dial?: (address: any) => any;
    },
  ) {
    super(args);
    this.#dial =
      (args as any).dial ??
      (() => {
        throw new Error("this context has no dial configured (no sturdy capabilities)");
      });
  }

  // The fold: one pure projection of an event into the next capability table.
  // Returning the same state for events we don't consume is the identity case.
  protected override reduce({ event, state }: { event: any; state: any }) {
    switch (event.type) {
      case ITX_EVENTS.capabilityProvided: {
        const { path, kind, address, meta } = event.payload;
        const name = path.join(".");
        return {
          ...state,
          capabilities: {
            ...state.capabilities,
            [name]: { name, kind, address: address ?? null, meta: meta ?? {} },
          },
        };
      }
      case ITX_EVENTS.capabilityRevoked: {
        const name = event.payload.path.join(".");
        const capabilities = { ...state.capabilities };
        delete capabilities[name];
        return { ...state, capabilities };
      }
      case ITX_EVENTS.contextCreated: {
        if (state.context) return state; // get-or-create: first one wins
        return {
          ...state,
          context: { name: event.payload.name ?? null, parent: event.payload.parent ?? null },
        };
      }
      default:
        return state;
    }
  }

  // provide = append an event. A live stub also lands in the in-memory bridge.
  // We self-ingest the committed event so the write is readable immediately
  // (read-your-writes) — the same event later re-delivered by the stream
  // subscription is deduped by offset.
  async provideCapability({
    path,
    capability,
    meta,
  }: {
    path: string[];
    capability: any;
    meta?: any;
  }) {
    const kind = isCapabilityAddress(capability) ? "rpc" : "live";
    if (kind === "live") this.#live.set(path.join("."), capability);
    const committed = await this.ctx.stream.append({
      event: {
        type: ITX_EVENTS.capabilityProvided,
        payload: { path, kind, address: kind === "rpc" ? capability : null, meta },
      },
    });
    await this.ingest({ events: [committed], streamMaxOffset: (committed as any).offset });
    return { path };
  }

  async revokeCapability({ path }: { path: string[] }) {
    const committed = await this.ctx.stream.append({
      event: { type: ITX_EVENTS.capabilityRevoked, payload: { path } },
    });
    await this.ingest({ events: [committed], streamMaxOffset: (committed as any).offset });
  }

  // invoke resolves over the FOLD (this.state), then borrows: a live entry's
  // stub from the bridge, a sturdy entry's address via dial. The remainder of
  // the path is replayed onto whatever we borrowed.
  async invoke({ path, args = [] }: { path: string[]; args?: unknown[] }) {
    const hit = resolveLongestPrefix(this.state.capabilities, path);
    if (!hit) throw new Error(`no capability "${path.join(".")}"`);
    if (hit.record.kind === "live") {
      const stub = this.#live.get(hit.name);
      if (!stub)
        throw new Error(`capability "${hit.name}" is offline (live provider disconnected)`);
      return await replayPath(stub, hit.rest, args);
    }
    return await replayPath(this.#dial(hit.record.address), hit.rest, args);
  }
}
