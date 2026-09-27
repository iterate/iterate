// context-stub.ts — A CONTEXT DURABLE OBJECT AS THE PLATFORM'S OWN CODE CALLS IT, under the one
// failure model (docs/engineering-invariants.md#failures-and-retries), so a call gets the same policy
// whichever hop makes it: the edge (iterate-context.ts), the owner contexts the session and the
// token endpoint read and append to (session.ts `ownerContext`).
import { z } from "zod";
import { itxExpressionStepName, type ItxExpression } from "iterate/expression";
import type { StreamProcessorDurableObject } from "iterate/sdk";
import { failureKind, ONCE_NOW, retryPlatformFailures } from "@iterate-com/shared/platform-retry";
import type { Caller } from "./caller.ts";
import type { DurableObjectAddress } from "./context/paths.ts";
import type { IterateContextNamespace } from "./iterate-context.ts";
import type { repoVerbs } from "./repo/durable-object.ts";
import { unavailable } from "./unavailable.ts";
import type { workspaceVerbs } from "./workspace/durable-object.ts";

/** The context Durable Object at `address`: each call on a fresh stub ("many exceptions leave the
 *  DurableObjectStub in a broken state, such that all attempts to send additional requests will
 *  just fail immediately with the original exception … create a new one", Cloudflare's
 *  error-handling guide). A call that is idempotent (`isIdempotentItxCall`) and that a deploy's reset
 *  or a lost connection failed is made ONCE more, at once; an overloaded one never
 *  (`retryPlatformFailures`, its lines named `<area>.…`). A platform failure that stands is thrown
 *  as UNAVAILABLE, its message kept. */
export function contextStub(
  namespace: IterateContextNamespace,
  address: DurableObjectAddress,
  area: string,
) {
  return {
    async invoke(itxExpression: ItxExpression, args: unknown[], caller: Caller): Promise<unknown> {
      try {
        return await retryPlatformFailures(
          // The stub's `invoke` is typed as workerd's RPC wrapper over the DO method; the call
          // denotes whatever expression the caller spelled, so `unknown` is the honest contract.
          async () =>
            (await namespace
              .getByName(address.name)
              .invoke(itxExpression, args, caller)) as unknown,
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
          },
        );
      } catch (error) {
        throw unavailable(error);
      }
    },
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
