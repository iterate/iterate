import { z } from "zod";

export const CALLABLE_SCHEMA = "https://schemas.iterate.com/callable/v1" as const;

const pathModeSchema = z.enum(["prefix", "replace"]);
const callableSchemaField = z.literal(CALLABLE_SCHEMA).optional();
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const passthroughArgsSchema = z.record(z.string(), jsonValueSchema);

/**
 * Service bindings, Durable Object stubs, Dynamic Worker entrypoints, and
 * loopback bindings are not URL-authorized resources; the resolved platform
 * object is the authority. Fetch callables may still choose a synthetic
 * request path via `fetchRequest.path.base`, but that is part of the Fetch
 * request shape rather than part of capability identity.
 */
const pathBaseSchema = z
  .string()
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !value.includes("?") &&
      !value.includes("#") &&
      !value.includes("\\"),
    {
      message:
        "path base must start with one / and must not be protocol-relative or include query/hash/backslash",
    },
  )
  .refine((value) => !hasDotPathSegment(value), {
    message: "path base must not include dot path segments",
  });

function hasDotPathSegment(path: string) {
  return path.split("/").some((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === "." || decoded === "..";
    } catch {
      return segment === "." || segment === "..";
    }
  });
}

const httpUrlSchema = z.string().refine(
  (value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.hash === "" &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  },
  {
    message: "url must be an absolute http(s) URL without a hash or credentials",
  },
);

/**
 * This is deliberately stricter than JavaScript property access. A serialized
 * RPC callable should name one direct public method, not walk object graphs or
 * collide with Promise/prototype/reserved Worker RPC behavior. Cloudflare
 * reserves several RPC method names, and `then` is denied so a service binding
 * or returned stub cannot accidentally become Promise-like when awaited.
 * The Cloudflare-reserved names are documented here:
 * https://developers.cloudflare.com/workers/runtime-apis/rpc/reserved-methods/
 */
const deniedRpcMethods = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "alarm",
  "apply",
  "bind",
  "call",
  "connect",
  "constructor",
  "dup",
  "fetch",
  "hasOwnProperty",
  "isPrototypeOf",
  "prototype",
  "propertyIsEnumerable",
  "then",
  "toLocaleString",
  "toString",
  "valueOf",
  "webSocketClose",
  "webSocketError",
  "webSocketMessage",
]);

const rpcMethodSchema = z
  .string()
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, {
    message: "RPC call method must be a single JavaScript identifier, not a dotted path",
  })
  .refine((value) => !deniedRpcMethods.has(value), {
    message: "RPC call method uses a reserved or dangerous method name",
  });

const dynamicWorkerCodeSchema = z
  .object({
    compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    compatibilityFlags: z.array(z.string()).optional(),
    mainModule: z.string().min(1),
    modules: z.record(z.string(), z.string()),
  })
  .strict()
  .superRefine((code, ctx) => {
    if (!(code.mainModule in code.modules)) {
      ctx.addIssue({
        code: "custom",
        message: "Dynamic Worker mainModule must be present in modules",
        path: ["mainModule"],
      });
    }

    for (const moduleName of Object.keys(code.modules)) {
      if (!moduleName.endsWith(".js")) {
        ctx.addIssue({
          code: "custom",
          message: "Dynamic Worker module names must end in .js in callable v1",
          path: ["modules", moduleName],
        });
      }
    }
  });

const durableObjectSelectorSchema = z.union([
  z.object({ name: z.string().min(1) }).strict(),
  z.object({ id: z.string().min(1) }).strict(),
]);

const dynamicWorkerLoaderSchema = z
  .object({
    type: z.literal("get"),
    id: z.string().min(1),
  })
  .strict();

const dynamicWorkerEntrypointSchema = z
  .object({
    name: z.string().min(1).optional(),
    props: jsonValueSchema.optional(),
  })
  .strict();

/**
 * Dynamic Worker `via` values intentionally keep only the Worker Loader env
 * binding, inline JavaScript source, optional `get()` identity, and optional
 * entrypoint selection. Fields
 * like `env`, `globalOutbound`, tails, and typed modules are real platform
 * features, but they expand the capability surface. V1 parks them in tasks
 * until we add the policy layer that should govern them:
 * https://developers.cloudflare.com/dynamic-workers/api-reference/
 *
 * The loader env binding defaults to `LOADER`. The property is deliberately
 * named `workerLoaderBindingName`, not `bindingName`: the callable invokes the
 * loaded Dynamic Worker entrypoint, but the env capability used to get there is
 * specifically a Worker Loader binding.
 * https://developers.cloudflare.com/workers/runtime-apis/bindings/
 */
const dynamicWorkerViaSchema = z
  .object({
    type: z.literal("env-binding"),
    bindingType: z.literal("dynamic-worker"),
    workerLoaderBindingName: z.string().min(1).optional(),
    workerCode: dynamicWorkerCodeSchema,
    loader: dynamicWorkerLoaderSchema.optional(),
    entrypoint: dynamicWorkerEntrypointSchema.optional(),
  })
  .strict();

/**
 * `env-binding` via values resolve through `CallableContext.env[bindingName]`.
 *
 * Cloudflare describes bindings as "a permission and an API in one piece".
 * This callable stores only the configured binding name and expected binding
 * type; the live binding object is supplied by the caller's context at dispatch
 * time.
 * https://developers.cloudflare.com/workers/runtime-apis/bindings/
 */
const serviceEnvBindingViaSchema = z
  .object({
    type: z.literal("env-binding"),
    bindingType: z.literal("service"),
    bindingName: z.string().min(1),
  })
  .strict();

/**
 * Durable Object callables resolve a Durable Object namespace binding, then use
 * either `getByName(name)` or `idFromString(id)` + `get(id)` to obtain a
 * DurableObjectStub. The nested `durableObject` selector is intentionally not
 * called `address`: Cloudflare's first-party API talks about namespaces,
 * stubs, names, and IDs.
 * https://developers.cloudflare.com/durable-objects/api/namespace/
 */
const durableObjectEnvBindingViaSchema = z
  .object({
    type: z.literal("env-binding"),
    bindingType: z.literal("durable-object-namespace"),
    bindingName: z.string().min(1),
    durableObject: durableObjectSelectorSchema,
  })
  .strict();

/**
 * `loopback-binding` via values resolve through `CallableContext.exports`, which
 * is the `ctx.exports` object from a Worker or Durable Object invocation.
 *
 * Cloudflare documents these as automatically configured "loopback bindings"
 * for a Worker's top-level exports. Loopback service bindings can also be
 * parameterized with dynamic `props`, unlike regular env service bindings.
 * https://developers.cloudflare.com/workers/runtime-apis/context/#exports
 */
const loopbackServiceViaSchema = z
  .object({
    type: z.literal("loopback-binding"),
    bindingType: z.literal("service"),
    exportName: z.string().min(1),
    props: jsonValueSchema.optional(),
  })
  .strict();

const loopbackDurableObjectViaSchema = z
  .object({
    type: z.literal("loopback-binding"),
    bindingType: z.literal("durable-object-namespace"),
    exportName: z.string().min(1),
    durableObject: durableObjectSelectorSchema,
  })
  .strict();

const envBindingViaSchema = z.discriminatedUnion("bindingType", [
  serviceEnvBindingViaSchema,
  durableObjectEnvBindingViaSchema,
  dynamicWorkerViaSchema,
]);

const loopbackBindingViaSchema = z.discriminatedUnion("bindingType", [
  loopbackServiceViaSchema,
  loopbackDurableObjectViaSchema,
]);

const urlViaSchema = z
  .object({
    type: z.literal("url"),
    url: httpUrlSchema,
  })
  .strict();

const fetchViaSchema = z.union([urlViaSchema, envBindingViaSchema, loopbackBindingViaSchema]);

const workersRpcViaSchema = z.union([envBindingViaSchema, loopbackBindingViaSchema]);

const fetchRequestSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    path: z
      .object({
        base: pathBaseSchema.optional(),
        mode: pathModeSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const fetchCallableSchema = z
  .object({
    type: z.literal("fetch"),
    schema: callableSchemaField,
    via: fetchViaSchema,
    passthroughArgs: passthroughArgsSchema.optional(),
    fetchRequest: fetchRequestSchema.optional(),
  })
  .strict();

const workersRpcCallableSchema = z
  .object({
    type: z.literal("workers-rpc"),
    schema: callableSchemaField,
    via: workersRpcViaSchema,
    rpcMethod: rpcMethodSchema,
    argsMode: z.enum(["object", "positional"]).optional(),
    passthroughArgs: passthroughArgsSchema.optional(),
  })
  .strict()
  .superRefine((callable, ctx) => {
    if (callable.argsMode === "positional" && callable.passthroughArgs != null) {
      ctx.addIssue({
        code: "custom",
        message: "RPC positional argsMode cannot include passthroughArgs",
        path: ["passthroughArgs"],
      });
    }
  });

/**
 * A `Callable` is intentionally just JSON data. It names a way to invoke
 * something, but it does not contain the live Worker binding, Durable Object
 * stub, or public `fetch` capability.
 *
 * Treat a Callable as untrusted code. Dispatching it with `ctx.env` is an
 * explicit decision to let the JSON select from those binding names. V1 keeps
 * policy out of the kernel so the first slice stays small, but callers must not
 * pass sensitive bindings unless they mean to make them nameable by the
 * Callable. `tasks/capability-policy.md` tracks the hardened resolver/policy
 * layer.
 */
export const CallableSchema = z.discriminatedUnion("type", [
  fetchCallableSchema,
  workersRpcCallableSchema,
]);

/**
 * JSON that names an invocation protocol and the capability to invoke it via.
 *
 * Dispatching a Callable resolves live authority from `CallableContext`: public
 * HTTP fetch, Worker bindings, Durable Object namespaces, and Worker Loader
 * bindings are not stored in the callable itself. Treat Callables as
 * untrusted code until the capability-policy task is implemented.
 */
export type Callable = z.infer<typeof CallableSchema>;
export type FetchCallable = z.infer<typeof fetchCallableSchema>;
export type WorkersRpcCallable = z.infer<typeof workersRpcCallableSchema>;
export type DurableObjectSelector = z.infer<typeof durableObjectSelectorSchema>;

export type CallableContext = {
  /**
   * Worker bindings keyed by their runtime binding name. `env-binding` via
   * keep only `bindingName`, so this object is where a stored Callable resolves
   * to a live platform capability.
   *
   * Cloudflare bindings are intentionally capability-bearing APIs, not plain
   * configuration values:
   * https://developers.cloudflare.com/workers/runtime-apis/bindings/
   */
  env?: Record<string, unknown>;
  /**
   * Loopback bindings from `ctx.exports`, keyed by top-level export name.
   *
   * Cloudflare documents `ctx.exports` as automatically configured loopback
   * bindings for this Worker's own exports. They can represent service
   * bindings and Durable Object namespace bindings. Loopback service bindings
   * can also receive dynamic `props`.
   * https://developers.cloudflare.com/workers/runtime-apis/context/#exports
   */
  exports?: Record<string, unknown>;
  /**
   * Public URL fetch capability used only by callables using
   * `{ type: "url" }`.
   *
   * Worker-boundary code can pass the runtime function directly as
   * `{ fetch }`. Keeping it explicit is important: public egress should not be
   * created by a shared helper silently reading `globalThis.fetch`. Env and
   * loopback binding via values ignore this field because their authority comes
   * from `env` or `ctx.exports`.
   */
  fetch?: typeof globalThis.fetch;
};

export type CallableErrorCode =
  | "DESCRIPTOR_VALIDATION_FAILED"
  | "PAYLOAD_VALIDATION_FAILED"
  | "RESOLUTION_FAILED"
  | "TRANSPORT_FAILED"
  | "REMOTE_ERROR";

export class CallableError extends Error {
  readonly code: CallableErrorCode;
  readonly retryable: boolean;
  readonly cause: unknown;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: CallableErrorCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "CallableError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
    this.details = options.details;
  }
}
