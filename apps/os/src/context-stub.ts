// context-stub.ts — A CONTEXT DURABLE OBJECT AS THE PLATFORM'S OWN CODE CALLS IT, under the one
// failure model (docs/engineering-invariants.md#failures-and-retries), so a call gets the same policy
// whichever hop makes it: the edge (iterate-context.ts), /mcp, the owner contexts the session and
// the token endpoint read and append to (session.ts `ownerContext`), and every call a context or
// loaded code sends to the context it lives in (context/stateless-context.ts `contextReach`).
import { z } from "zod";
import type { WaitForEventFilter } from "iterate/api";
import { itxExpressionStepName, type ItxExpression } from "iterate/expression";
import { releaseRpcSessions } from "iterate/lib";
import type { StreamProcessorDurableObject } from "iterate/sdk";
import type { StreamEvent } from "iterate/stream/processor";
import { failureKind, ONCE_NOW, retryPlatformFailures } from "iterate/platform-retry";
import type { Caller } from "./caller.ts";
import { DurableObjectNameCodec, type DurableObjectAddress } from "./context/paths.ts";
import type { IterateContextNamespace } from "./iterate-context.ts";
import { ScriptRunRequested, settlementOfScriptRun } from "./library.ts";
import type { repoVerbs } from "./repo/durable-object.ts";
import { unavailable } from "./unavailable.ts";
import type { workspaceVerbs } from "./workspace/durable-object.ts";

/** The context Durable Object at `address`: each call on a fresh stub ("many exceptions leave the
 *  DurableObjectStub in a broken state, such that all attempts to send additional requests will
 *  just fail immediately with the original exception … create a new one", Cloudflare's
 *  error-handling guide). A call that is idempotent (`isIdempotentItxCall`) and that a deploy's reset
 *  or a lost connection failed is made ONCE more, at once; an overloaded one never
 *  (`retryPlatformFailures`, its lines named `<area>.…`). A platform failure that stands is thrown
 *  as UNAVAILABLE, its message kept. A context answers `itx.run` with the request
 *  (library.ts `ScriptRunRequested`), and the call answers with the run's settlement, read here in
 *  slices of fresh calls (`settlementOfScriptRun`): no call is held on one instance for a run's
 *  length. `readsRunSettlements: false` is a context's Durable Object sending on the call it was
 *  made (context/stateless-context.ts `contextReach`): it answers the request as it came, and its
 *  own caller's side reads the settlement, so no context between the two is held for the run
 *  either. */
export function contextStub(
  namespace: Pick<IterateContextNamespace, "getByName">,
  address: DurableObjectAddress,
  area: string,
  { readsRunSettlements = true }: { readsRunSettlements?: boolean } = {},
) {
  return {
    /** `givenUp`: the caller stopped waiting for this call's answer, so the call left pending is
     *  released and never repeated. */
    async invoke(
      itxExpression: ItxExpression,
      args: unknown[],
      caller: Caller,
      givenUp?: AbortSignal,
    ): Promise<unknown> {
      let answer: unknown;
      try {
        answer = await retryPlatformFailures(
          async () => {
            const call = namespace.getByName(address.name).invoke(itxExpression, args, caller);
            // A call that threw, or that its caller gave up on, holds its session, and the context
            // with it, until its promise is released (context/dispatch.ts
            // `awaitAnswerReleasedIfRejected` says why).
            const release = () => releaseRpcSessions([call]);
            givenUp?.addEventListener("abort", release, { once: true });
            try {
              // The stub's `invoke` is typed as workerd's RPC wrapper over the DO method; the call
              // denotes whatever expression the caller spelled, so `unknown` is the honest contract.
              return (await call) as unknown;
            } catch (error) {
              release();
              throw error;
            } finally {
              givenUp?.removeEventListener("abort", release);
            }
          },
          {
            area,
            schedule: ONCE_NOW,
            idempotent: isIdempotentItxCall(itxExpression, args),
            kind: failureKind,
            describe: () => ({
              name: itxExpression.map(itxExpressionStepName).join("."),
              projectId: address.projectId,
              path: address.path,
            }),
            signal: givenUp,
          },
        );
      } catch (error) {
        throw unavailable(error);
      }
      if (!readsRunSettlements) return answer;
      const requested = ScriptRunRequested.safeParse(answer);
      if (!requested.success) return answer;
      releaseRpcSessions([answer]); // parsed into a copy of its own
      return settlementOfScriptRun(
        requested.data,
        waitForEventOnContext(namespace, address.projectId),
      );
    },
  };
}

/** A first-party facet's folded state on `context`, the platform's own read at the fixed point: no
 *  rewrite row of that context's redirects or masks it. `invoke` answers `unknown` across the DO
 *  hop; a first-party facet's `snapshot()` is the engine's `{ offset, state }`, its state the
 *  facet contract's. */
export async function facetStateOf<State>(
  context: { invoke(call: ItxExpression, args: unknown[], caller: Caller): Promise<unknown> },
  facet: string,
  caller: Caller,
): Promise<State> {
  const snapshot = await context.invoke(
    ["itx", "builtins", "facets", ["get", facet], ["snapshot"]],
    [],
    caller,
  );
  return (snapshot as { state: State }).state;
}

/** `settlementOfScriptRun`'s reads: one `waitForEvent` on a fresh stub of the context at `path` in
 *  `projectId`, spelled at the fixed point with no principal — the platform's own read of its own
 *  record, whoever asked for the run — its lines named `itx-run.…`. */
export function waitForEventOnContext(
  namespace: Pick<IterateContextNamespace, "getByName">,
  projectId: string,
) {
  return async (
    path: string,
    filter: WaitForEventFilter,
    givenUp: AbortSignal,
  ): Promise<StreamEvent> => {
    const found = await contextStub(
      namespace,
      DurableObjectNameCodec.address({ projectId, path }),
      "itx-run",
    ).invoke(["itx", "builtins", ["waitForEvent", filter]], [], { principal: null }, givenUp);
    try {
      // The context's own `waitForEvent` answers the event it found: copied out, and the RPC
      // result, which holds the context until released, released.
      return structuredClone(found) as StreamEvent;
    } finally {
      releaseRpcSessions([found]);
    }
  };
}

/** The calls running twice is running once, by the names of their steps after `itx` (and any
 *  `builtins` or `cd(path)` before them): the reads, and `processors.enable`, which appends nothing
 *  for a row that already hosts the same spec. A call is judged as the caller spelled it: a
 *  context's own row that redirects one of these names to a write, or a facet class that overrides
 *  one of the SDK's processor reads with a write, is its owner's to keep safe to repeat. */
const IDEMPOTENT_CALLS: ReadonlySet<string> = new Set([
  "whoami",
  "readEvents",
  "waitForEvent",
  "kv.get",
  "kv.list",
  "rewriteRules.list",
  "subscriptions.list",
  "processors.list",
  "processors.enable",
  "secrets.clientSecretFor",
  ...(
    [
      "snapshot",
      "liveSnapshot",
      "waitUntilProcessed",
    ] satisfies (keyof StreamProcessorDurableObject)[]
  ).map((read) => `facets.get.${read}`),
  "repos.list",
  ...(
    [
      "tip",
      "readFile",
      "modules",
      "listFiles",
      "log",
      "origin",
    ] satisfies (typeof repoVerbs)[number][]
  ).map((verb) => `repos.get.${verb}`),
  "workspaces.list",
  ...(
    [
      "mounts",
      "readFile",
      "readBase",
      "listAllFiles",
      "gitStatus",
      "gitLog",
    ] satisfies (typeof workspaceVerbs)[number][]
  ).map((verb) => `workspaces.get.${verb}`),
]);

/** An event the log answers with itself when it lands twice: a durable one under an idempotency key,
 *  which stream/stream.ts finds in its rows. An ephemeral is never stored, so its key matches
 *  nothing on a second call. */
const KeyedDurableEvent = z.object({
  idempotencyKey: z.string().min(1),
  ephemeral: z.literal(false).optional(),
});

/** Whether running `itxExpression` twice is running it once: one of `IDEMPOTENT_CALLS`, or an
 *  append whose every event is durable and carries an idempotency key. A call with live args (a
 *  Request, a callback) is neither. */
function isIdempotentItxCall(itxExpression: ItxExpression, args: unknown[]): boolean {
  if (args.length > 0) return false;
  let steps = itxExpression.slice(itxExpression[1] === "builtins" ? 2 : 1);
  while (Array.isArray(steps[0]) && steps[0][0] === "cd") steps = steps.slice(1);
  const [call] = steps;
  if (steps.length === 1 && Array.isArray(call) && call[0] === "append")
    return (
      call.length > 1 && call.slice(1).every((event) => KeyedDurableEvent.safeParse(event).success)
    );
  return IDEMPOTENT_CALLS.has(steps.map(itxExpressionStepName).join("."));
}
