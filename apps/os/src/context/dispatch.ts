// context/dispatch.ts — what the PLATFORM does with a rewritten itx expression: EXECUTE its steps
// against a live object graph, and hand back an answer that holds nothing of the call's session. It
// runs only in this worker — the resolver (itx-expression-rewriting.ts), the facet host
// (facet-host.ts), the subscription delivery loop (stream/subscription-delivery.ts) and a context's
// RPC `invoke` (iterate-context-durable-object.ts) — so it is apps/os's, not the SDK's. The codec it
// walks (parse ⇄ print) and the dotted surface it answers with (`InvokeHandle`) are the SDK's
// (packages/iterate/src/expression.ts): user code spells expressions and holds handles too.
//   walk      — `walkSteps` / `callOn` and the brands registered at boot
//   brands    — `FacetHandle` / `RpcStubHandle`, what the delivery loop reads
//   answers   — `itxAnswerDetachedFromSession` / `materializeItxHandleReference`: a handle on the wire
//               is the expression that names it
import { RpcTarget } from "capnweb";
import {
  InvokeHandle,
  normalizedItxExpression,
  print,
  type ItxExpression,
  type ItxExpressionInput,
} from "iterate/expression";
import { codedError, releaseRpcSessions } from "iterate/lib";

// ── walk ── EXECUTE a rewritten call's steps against a LIVE object graph (the codec that turns
// strings ⇄ these structures is the SDK's; the rules that rewrite a call to a built-in root are
// itx-expression-rewriting.ts). `walkSteps` is THE step walk —
// `ItxExpressionResolver` replays the steps after the root with it; the facet dispatch and the delivery
// loop walk steps on a local object with it. `callOn` applies args to a resolved value. The dotted write-half (a handle
// whose dotted access reduces into one dispatch) is the SDK's `InvokeHandle` — the ONE such
// primitive, pipelinable over Workers RPC.

// Promise brands the step walk threads UNAWAITED: property access and calls pipeline on them
// natively, so the whole chain reduces into one round trip and the caller's terminal await is the
// single flush. iterate-context.ts registers the native cloudflare:workers brands and capnweb's at boot — that
// import can't live here because the Node unit tests run this module, where the list stays empty
// and every step is simply awaited.
const PIPELINED_RPC_BRANDS: (abstract new (...args: never[]) => unknown)[] = [];
/** Register a pipelinable promise brand (the workerd entrypoint's two calls at boot). */
export function registerPipelinedRpcBrand(brand: abstract new (...args: never[]) => unknown): void {
  PIPELINED_RPC_BRANDS.push(brand);
}
const pipelined = (v: unknown): boolean => PIPELINED_RPC_BRANDS.some((b) => v instanceof b);

// Workers-RPC brands whose every value HOLDS A SESSION — and the actor at its far end — open until
// disposed: a stub, a call's promise, a property. Registered at boot beside the pipelined brands
// (iterate-context.ts), for the same reason: the unit tests run this module in Node.
const RPC_SESSION_BRANDS: (abstract new (...args: never[]) => unknown)[] = [];
/** Register a brand whose values hold a Workers-RPC session until disposed. */
export function registerRpcSessionBrand(brand: abstract new (...args: never[]) => unknown): void {
  RPC_SESSION_BRANDS.push(brand);
}
const holdsRpcSession = (v: unknown): boolean => RPC_SESSION_BRANDS.some((b) => v instanceof b);

/** A walk's ANSWER (`walkSteps`' value), awaited — and RELEASED if it rejects. A Workers-RPC call
 *  that threw keeps its session open, and the actor at its far end with it, until its promise is
 *  disposed: workerd drops a call's pipeline when an answer arrives, never when an exception does,
 *  and an idle isolate may not collect the promise for many minutes (measured 2026-09-23: a context
 *  whose facet threw once was held resident, billed, 20 minutes on). Its caller receives the
 *  rejection, never the promise, so the walk's owner releases it here. An answer that arrives is
 *  the caller's, as ever. */
export async function awaitAnswerReleasedIfRejected(answer: unknown): Promise<unknown> {
  try {
    return await answer;
  } catch (error) {
    if (holdsRpcSession(answer)) releaseRpcSessions([answer]);
    throw error;
  }
}

/** Resolve one step's property. `__proto__` / `constructor` / `prototype` never resolve — `constructor`
 *  would hand out the class itself (trusted clients or not, that is not a step anyone means). */
function stepGet(value: object, key: string): unknown {
  if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
  return Reflect.get(value, key);
}

/**
 * THE step walk: property steps `Reflect.get` with the receiver carried; call steps `Reflect.apply`
 * ON that receiver (detaching a method from a Workers-RPC receiver breaks it); an ordinary promise
 * is awaited between steps, a branded one (PIPELINED_RPC_BRANDS, above) is not.
 *
 * ⚠️  DataCloneError LEARNING:
 * invoke facet/RPC-stub methods with `Reflect.apply(fn, receiver, args)`, NEVER `stub[m].apply(stub,
 * args)`. Reading `.apply` off an RPC stub's method proxy is a capnweb PIPELINED REMOTE PATH;
 * calling it passes the stub as an argument, so workerd serializes it — and a Worker-Loader facet
 * stub may never be serialized (`requireAllowsTransfer()` throws unconditionally) → `DataCloneError:
 * Durable Object Facet stubs cannot be transferred between Workers`. Do not "simplify" this away.
 *
 * `rpcSessionsSteppedPast`, when given, collects every value the walk stepped PAST that holds a
 * Workers-RPC session — pipelined (the `repos()` promise of `facet.repos().create(path)`) or awaited
 * (the collection stub a facet call answered, walked on for `.list()`): each keeps its session, and the
 * actor at its far end, open until disposed, so the walk's owner releases them once the answer is in
 * (`releaseRpcSessions`; the resolver's `invoke`, facet-host.ts `#call`). Never the start, never the
 * answer — which its owner awaits with `awaitAnswerReleasedIfRejected`.
 */
export async function walkSteps(
  start: { value: unknown; receiver: unknown },
  steps: ItxExpression,
  rpcSessionsSteppedPast?: unknown[],
): Promise<{ value: unknown; receiver: unknown }> {
  let { value, receiver } = start;
  for (const [stepIndex, step] of steps.entries()) {
    if (!pipelined(value)) value = await value;
    if (stepIndex > 0 && holdsRpcSession(value)) rpcSessionsSteppedPast?.push(value);
    if (value == null)
      throw new Error(
        `hit ${String(value)} at step ${stepIndex + 1} of ${print(steps)} (${JSON.stringify(step)})`,
      );
    if (typeof step === "string") {
      receiver = value;
      value = stepGet(value as object, step);
    } else {
      const [method, ...args] = step;
      if (method === "") {
        // the ANONYMOUS call step (iterate/expression): call the value itself — a live stub's root call
        value = callOn(value, receiver, args);
        receiver = undefined;
        if (!pipelined(value)) value = await value;
        continue;
      }
      const fn = stepGet(value as object, method);
      if (typeof fn !== "function")
        throw codedError(
          "NOT_A_METHOD",
          `${JSON.stringify(method)} is not a method at step ${stepIndex + 1} of ${print(steps)}`,
        );
      receiver = undefined;
      value = Reflect.apply(fn, value, args);
      if (!pipelined(value)) value = await value;
    }
  }
  return { value: pipelined(value) ? value : await value, receiver };
}

/** Apply `args` to a resolved value on its carried receiver, or a LOUD error if it is not callable
 *  (never a silent argument drop). An `InvokeHandle` is NOT a JS function (a real
 *  RpcTarget so dotted access pipelines — iterate/expression's invoke handle section), so ROOT-calling it dispatches
 *  those args at its EMPTY path: `handle(events,range)` ⇒ the bare callback the handle fronts. The one
 *  bridge between "callable capability" and "pipelinable RpcTarget". */
export async function callOn(value: unknown, receiver: unknown, args: unknown[]): Promise<unknown> {
  if (typeof value === "function") return Reflect.apply(value, receiver, args);
  if (value instanceof InvokeHandle) return value.applyRoot(args);
  throw codedError("NOT_A_METHOD", `target is not callable but ${args.length} arg(s) were passed`);
}

// ── the two BRANDS the subscription delivery loop reads: the kinds that OWN THEIR PROGRESS, so a push
// needs no cursor on the stream side (subscription-delivery.ts). Nothing is declared on any event;
// the brand is minted where the built-in mints the handle. ──

/** `itx.facets.get(name)` / `itx.facets.get(name, { source, className })` — a facet of this context. */
export class FacetHandle extends InvokeHandle {}

/** `itx.rpcStubs.get(key)` — a live stub lent to the registry. */
export class RpcStubHandle extends InvokeHandle {}

/** A HANDLE ON THE WIRE IS THE EXPRESSION THAT NAMES IT. An `InvokeHandle` a context mints (`repos.get(path)`,
 *  `workspaces.get(path)`, `facets.get(name)`, `cd(path)`, `workers.get(spec)`, `rpcStubs.get(key)`)
 *  holds no state — it is a dispatch closure over a path or a key — yet as a Workers-RPC result it would
 *  cross a hop as a LIVE stub whose session keeps the context's actor resident for as long as the holder
 *  keeps it (prd 2026-09-22: ~125 such sessions parked around the clock). So the context answers with
 *  THIS instead: the caller's own expression, which from the caller's root denotes the same handle; the
 *  caller mints its own handle over it (`materializeItxHandleReference`), and every later verb is one
 *  whole call the context resolves from scratch. Nothing outlives a call. */
export const ITX_HANDLE_REFERENCE_KEY = "$itxHandleExpression";
export type ItxHandleReference = { [ITX_HANDLE_REFERENCE_KEY]: ItxExpression };

const isItxHandleReference = (value: unknown): value is ItxHandleReference =>
  Boolean(value) &&
  typeof value === "object" &&
  Array.isArray((value as Record<string, unknown>)[ITX_HANDLE_REFERENCE_KEY]);

/** An object a Workers-RPC call answered with: workerd gives every such object but a stub a
 *  `Symbol.dispose` that releases what that call left open. */
const isRpcResultWithDisposer = (value: unknown): value is Disposable =>
  // A primitive or null reads as no disposer; an object's is whatever it carries.
  typeof (value as Partial<Disposable> | null | undefined)?.[Symbol.dispose] === "function";

/** A CONTEXT'S INBOUND SESSION ENDS WITH THE CALL, WHATEVER THE CALLER KEEPS — and a careless caller
 *  (userspace code) keeps everything and disposes nothing. What a context's RPC `invoke` hands back for
 *  `expression`'s result, `args` being the call's runtime args:
 *   - A LIVE result — any `InvokeHandle` (a lent stub's `RpcStubHandle` too: it dispatches by its key,
 *     so the key's expression reaches the same lent stub), any other RpcTarget, a function, a
 *     Workers-RPC stub a hop below answered with, a reference a hop below answered with — becomes the
 *     expression that names it, re-rooted at THIS caller, and a stub is released. Runtime args fold
 *     into a terminal NAME as the resolver folds them; any left over are the anonymous call on the
 *     value, as the resolver applies them.
 *   - DATA a hop below answered with carries that hop's disposer, and workerd keeps a call's session —
 *     and the actor — open for as long as the caller holds an answer that has one (measured 2026-09-23:
 *     a facet holding a loaded worker's `{ a: 1 }` that its context handed through kept the context
 *     resident until the next deploy). It is copied, and the original released.
 *   - Everything else crosses as it is: data built here, a primitive, and what can neither be copied
 *     nor named — a stream, a Response, data holding a stub — which stays the holder's to release. */
export function itxAnswerDetachedFromSession(
  result: unknown,
  expression: ItxExpression,
  args: unknown[] = [],
): unknown {
  const last = expression.at(-1);
  const reference: ItxHandleReference = {
    [ITX_HANDLE_REFERENCE_KEY]:
      args.length === 0
        ? expression
        : typeof last === "string" && expression.length > 1
          ? [...expression.slice(0, -1), [last, ...args]]
          : [...expression, ["", ...args]],
  };
  if (holdsRpcSession(result)) {
    releaseRpcSessions([result]);
    return reference;
  }
  if (result instanceof RpcTarget || typeof result === "function" || isItxHandleReference(result))
    return reference;
  if (!isRpcResultWithDisposer(result)) return result;
  let copy: unknown;
  try {
    copy = structuredClone(result);
  } catch {
    return result; // a stream, a Response, data holding a stub: not data a copy can carry
  }
  releaseRpcSessions([result]);
  return copy;
}

/** The holder's side: a reference becomes a handle of the HOLDER's own whose every dotted call is one
 *  whole expression through `invoke` — the reference's expression plus the steps. Anything else passes
 *  through untouched. The proxy hands relative steps; a caller's own `.invoke("itx.whoami()")` is a
 *  whole call, spelled from the root. */
export function materializeItxHandleReference(
  result: unknown,
  invoke: (expression: ItxExpression) => unknown,
): unknown {
  if (!isItxHandleReference(result)) return result;
  const expression = result[ITX_HANDLE_REFERENCE_KEY];
  return new InvokeHandle((steps) =>
    invoke(
      typeof steps === "string" || steps[0] === "itx"
        ? normalizedItxExpression(steps as ItxExpressionInput)
        : [...expression, ...steps],
    ),
  );
}
