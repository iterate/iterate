// sdk/call-with-cause.ts — `walkUnderCause`, the walk behind every `callWithCause`: the SDK hosts'
// (index.ts), and the one every loaded `WorkerEntrypoint` gets (loaded-worker.ts). Its own module,
// so a loaded isolate that never imports the SDK's hosts never evaluates them.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { runCausedBy } from "../cause.ts";
import { codedError } from "../lib.ts";

/** A step of `callWithCause`'s walk, which reaches no further than Workers RPC would: on this facet
 *  or an RpcTarget, a member its class declares (never a field of its own); anything on a stub; on
 *  plain data, its own members (never a method of data the facet holds live). */
/** An expression's steps past a host: a property, or a method and its arguments. */
export type RpcSteps = (string | [string, ...unknown[]])[];

/** `callWithCause` (../cause.ts): the platform's way to walk `steps` on `host` under the cause of
 *  the call that made it — only as far as Workers RPC would reach, and never into `callWithCause`
 *  itself or `getItx`, which Workers RPC reaches on every loaded entrypoint (loaded-worker.ts). */
export function walkUnderCause(host: object, cause: unknown, steps: RpcSteps): Promise<unknown> {
  return runCausedBy(cause, async () => {
    let value: unknown = host;
    for (const step of steps) {
      const [name, ...args] = typeof step === "string" ? [step] : step;
      if (name === "callWithCause")
        throw codedError("NOT_A_METHOD", "callWithCause is the platform's alone");
      if (name === "getItx") throw codedError("NOT_A_METHOD", "getItx is the code's own");
      const member = memberRpcReaches(value, name);
      value =
        typeof step === "string"
          ? await member
          : // a step with arguments calls its member; Reflect.apply throws on anything else
            await Reflect.apply(member as (...a: unknown[]) => unknown, value, args);
    }
    return value;
  });
}

function memberRpcReaches(value: unknown, name: string): unknown {
  // (RpcStub's own type is generic past what TypeScript will narrow)
  if (value instanceof (RpcStub as unknown as new () => object))
    return (value as Record<string, unknown>)[name];
  const prototype = typeof value === "object" && value ? Object.getPrototypeOf(value) : undefined;
  const reaches =
    value instanceof RpcTarget ||
    value instanceof DurableObject ||
    value instanceof WorkerEntrypoint
      ? name in value && !Object.hasOwn(value, name) && !(name in Object.prototype)
      : // one of these prototypes means `value` is an object
        (prototype === Object.prototype || prototype === Array.prototype || prototype === null) &&
        Object.hasOwn(value as object, name);
  if (!reaches) throw codedError("NOT_A_METHOD", `${name} is no method Workers RPC would reach`);
  // `reaches` holds only for an object: its member, read by name
  return (value as Record<string, unknown>)[name];
}
