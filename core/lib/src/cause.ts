// cause.ts — the SDK's half of the loop guard, INTERNAL: no export names it and no signature takes
// it (core/os src/cause.ts explains the guard). A host's `callWithCause` (every loaded entrypoint
// has one, sdk/loaded-worker.ts), and its `fetch` under a Request's mark, run their code under the
// cause the platform handed them, and this carries that cause, unread, to every `getItx` scope
// and, in a loaded isolate, every outbound `fetch`.
// Any other code runs, in a loaded isolate, under the newest cause its isolate saw, and in the
// platform's own, shared by every project, under none. Shared by name
// (`Symbol.for("iterate.cause")`), so every copy of the SDK in an isolate reaches the same one.

// The SDK is typed against the Cloudflare types, never Node's: workerd hands this module to loaded
// workers under `nodejs_als` alone (core/os context/worker-loader.ts), Node to the unit tests.
// @ts-ignore -- without Node's types the import has none; it is typed right below
import { AsyncLocalStorage as NodeAsyncLocalStorage } from "node:async_hooks";
import { ITERATE_CAUSE_HEADER, loopLimitOf } from "./lib.ts";

type Carrier = {
  run<T>(cause: unknown, code: () => T): T;
  current(): unknown;
  carryOnFetch(): void;
};

const carrier = ((globalThis as Record<symbol, Carrier | undefined>)[
  Symbol.for("iterate.cause")
] ??= newCarrier());

function newCarrier(): Carrier {
  const AsyncLocalStorage = NodeAsyncLocalStorage as new <T>() => {
    run<R>(store: T, code: () => R): R;
    getStore(): T | undefined;
  };
  const running = new AsyncLocalStorage<{ cause: unknown }>();
  /** Set in a loaded isolate (`carryOnFetch`): only there is the newest cause kept. */
  let loaded = false;
  let newest: unknown;
  const current = () => {
    const store = running.getStore();
    return store ? store.cause : newest;
  };
  return {
    run(cause, code) {
      // what a call needs only for itself (its hops, the delivery its writes are keyed by) is not
      // kept; the cause is carried unread (`unknown`), so only the fields kept are named
      const { chain, depth, parent } = (cause ?? {}) as {
        chain?: unknown;
        depth?: unknown;
        parent?: unknown;
      };
      if (loaded) newest = chain === undefined ? undefined : { chain, depth, parent };
      return running.run({ cause }, code);
    },
    current,
    carryOnFetch() {
      if (loaded) return;
      loaded = true;
      const outbound = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        // the cause is carried unread, so `current()` is `unknown`: the mark reads its fields alone
        const cause = current() as
          | { chain?: unknown; depth?: unknown; hops?: unknown; parent?: unknown }
          | undefined;
        const request = new Request(input, init);
        // the mark alone, never what only a call needs (the delivery its writes are keyed by); a
        // header is bytes, so a parent in other characters than printable ASCII stays behind
        if (cause) {
          const { chain, depth, hops, parent } = cause;
          const ascii = typeof parent === "string" && /^[\x20-\x7e]*$/.test(parent);
          request.headers.set(
            ITERATE_CAUSE_HEADER,
            JSON.stringify({ chain, depth, hops, ...(ascii && { parent }) }),
          );
        }
        const answer = await outbound(request);
        // a request refused past the loop limit answers 508, marked: it throws as the refusal it is
        const refused = await loopLimitOf(answer);
        if (refused) throw refused;
        return answer;
      };
    },
  };
}

/** Run `code` under `cause` — the platform's word for why, or none (the platform then begins a
 *  chain for what it does). */
export const runCausedBy = <T>(cause: unknown, code: () => T): T => carrier.run(cause, code);

/** The cause the running code runs under, for the platform. */
export const currentCause = (): unknown => carrier.current();

/** In a LOADED isolate: every outbound `fetch` carries the cause it runs under (the platform's
 *  egress turns it into our mark) — installed before any of the loaded code's own module runs
 *  (sdk/loaded-worker.ts); the platform's isolate never is. */
export const carryCauseOnFetch = (): void => carrier.carryOnFetch();

/** The cause a Request carries, or none. */
export function causeOfRequest(request: Request): unknown {
  try {
    return JSON.parse(request.headers.get(ITERATE_CAUSE_HEADER) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
}
