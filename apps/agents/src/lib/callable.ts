import { z } from "zod";

/**
 * `Callable` is a JSON-serialisable description of something this Worker can
 * invoke at runtime. It carries no live bindings, functions, stubs, streams,
 * or secrets — bindings are named symbolically (e.g. `{ $binding: "MCP_CLIENT" }`)
 * and the dispatcher resolves them against `ctx.env` when called.
 *
 * Use these as wire payloads in events (e.g. `tool-provider-config-updated`),
 * stored config, or anywhere an LLM-/preset-authored handle to a runtime
 * capability is helpful.
 *
 * # Janky POC
 *
 * This file implements the smallest version of the spec sketched in this
 * project: it intentionally omits path prefix logic, WebSocket upgrade,
 * retries, structured `CallableError` body parsing, and binding-type checking.
 * Upgrade later when we have more than one consumer.
 */

const BindingRef = z.object({ $binding: z.string().min(1) });

const DurableObjectAddress = z.discriminatedUnion("type", [
  z.object({ type: z.literal("name"), name: z.string().min(1) }),
  z.object({ type: z.literal("id"), id: z.string().min(1) }),
]);

const FetchTarget = z.discriminatedUnion("type", [
  z.object({ type: z.literal("http"), url: z.string().url() }),
  z.object({ type: z.literal("service"), binding: BindingRef }),
  z.object({
    type: z.literal("durable-object"),
    binding: BindingRef,
    address: DurableObjectAddress,
  }),
]);

const RpcTarget = z.discriminatedUnion("type", [
  z.object({ type: z.literal("service"), binding: BindingRef }),
  z.object({
    type: z.literal("durable-object"),
    binding: BindingRef,
    address: DurableObjectAddress,
  }),
]);

export const Callable = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fetch"), target: FetchTarget }),
  z.object({
    kind: z.literal("rpc"),
    target: RpcTarget,
    rpcMethod: z.string().min(1),
    /**
     * `"object"` (default): payload is passed as a single argument.
     * `"positional"`: payload must be an array; spread into the RPC method.
     */
    argsMode: z.enum(["object", "positional"]).default("object"),
  }),
]);
export type Callable = z.infer<typeof Callable>;

export class CallableError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Callable failed with status ${status}: ${body}`);
    this.name = "CallableError";
  }
}

/**
 * Dispatch a {@link Callable}, returning the produced value.
 *
 * Fetch callables `POST` JSON to the resolved target and parse JSON/text by
 * `content-type`. Non-2xx responses become `CallableError`.
 *
 * RPC callables resolve the binding/DO stub, then invoke `rpcMethod(payload)`
 * (or spread the array payload when `argsMode === "positional"`).
 */
export async function dispatchCallable<T = unknown>(args: {
  callable: Callable;
  payload: unknown;
  ctx: { env: Record<string, unknown> };
}): Promise<T> {
  if (args.callable.kind === "fetch") {
    return (await dispatchFetch(args.callable, args.payload, args.ctx)) as T;
  }
  return (await dispatchRpc(args.callable, args.payload, args.ctx)) as T;
}

type FetchCallable = Extract<Callable, { kind: "fetch" }>;
type RpcCallable = Extract<Callable, { kind: "rpc" }>;

async function dispatchFetch(
  callable: FetchCallable,
  payload: unknown,
  ctx: { env: Record<string, unknown> },
): Promise<unknown> {
  const target = callable.target;
  let fetcher: { fetch: (req: Request) => Promise<Response> | Response };
  let url: string;
  if (target.type === "http") {
    fetcher = { fetch: (req) => globalThis.fetch(req) };
    url = target.url;
  } else if (target.type === "service") {
    fetcher = lookupBinding<Fetcher>(ctx.env, target.binding.$binding);
    url = `https://service-binding.invalid/${target.binding.$binding}`;
  } else {
    fetcher = resolveDurableObjectStub(ctx.env, target.binding.$binding, target.address);
    url = `https://durable-object.invalid/${target.binding.$binding}`;
  }
  const response = await fetcher.fetch(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? null),
    }),
  );
  if (!response.ok) {
    throw new CallableError(response.status, await response.text());
  }
  const responseContentType = response.headers.get("content-type") ?? "";
  return responseContentType.includes("application/json")
    ? await response.json()
    : await response.text();
}

async function dispatchRpc(
  callable: RpcCallable,
  payload: unknown,
  ctx: { env: Record<string, unknown> },
): Promise<unknown> {
  const target = callable.target;
  const stub =
    target.type === "service"
      ? lookupBinding<Record<string, unknown>>(ctx.env, target.binding.$binding)
      : resolveDurableObjectStub(ctx.env, target.binding.$binding, target.address);
  const method = (stub as Record<string, unknown>)[callable.rpcMethod];
  if (typeof method !== "function") {
    throw new Error(
      `RPC method "${callable.rpcMethod}" not found on binding "${target.binding.$binding}"`,
    );
  }
  if (callable.argsMode === "positional") {
    if (!Array.isArray(payload)) {
      throw new Error(
        `RPC callable with argsMode "positional" requires array payload, got ${typeof payload}`,
      );
    }
    return await (method as (...a: unknown[]) => Promise<unknown>).apply(stub, payload);
  }
  return await (method as (a: unknown) => Promise<unknown>).call(stub, payload);
}

function lookupBinding<T>(env: Record<string, unknown>, name: string): T {
  const value = env[name];
  if (value == null) throw new Error(`Binding "${name}" not present in env`);
  return value as T;
}

function resolveDurableObjectStub(
  env: Record<string, unknown>,
  bindingName: string,
  address: z.infer<typeof DurableObjectAddress>,
): DurableObjectStub {
  const ns = lookupBinding<DurableObjectNamespace>(env, bindingName);
  const id = address.type === "name" ? ns.idFromName(address.name) : ns.idFromString(address.id);
  return ns.get(id);
}
