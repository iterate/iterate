import { z } from "zod";

export const CALLABLE_SCHEMA = "https://schemas.iterate.com/callable/v1" as const;

const bindingRefSchema = z.object({ $binding: z.string().min(1) }).strict();

const pathModeSchema = z.enum(["prefix", "replace"]);
const callableSchemaField = z.literal(CALLABLE_SCHEMA).optional();

/**
 * Service bindings and Durable Object stubs are not URL-authorized resources;
 * the binding object is the authority. Fetch callables may still choose a
 * synthetic request path via `call.path.base`, but that is part of the call
 * shape rather than part of target identity.
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

const durableObjectAddressSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("name"), name: z.string().min(1) }).strict(),
  z.object({ type: z.literal("id"), id: z.string().min(1) }).strict(),
]);

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

const dynamicWorkerCacheSchema = z
  .object({
    mode: z.literal("get"),
    id: z.string().min(1),
  })
  .strict();

/**
 * Dynamic Worker targets intentionally keep only the loader, inline JavaScript
 * source, and optional `get()` cache identity. Fields like `env`,
 * `globalOutbound`, named entrypoints, tails, and typed modules are real
 * platform features, but they expand the capability surface. V1 parks them in
 * tasks until we add the policy layer that should govern them.
 */
const dynamicWorkerTargetSchema = z
  .object({
    type: z.literal("dynamic-worker"),
    loader: bindingRefSchema,
    code: dynamicWorkerCodeSchema,
    cache: dynamicWorkerCacheSchema.optional(),
  })
  .strict();

const fetchTargetSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("http"),
      url: httpUrlSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("service"),
      binding: bindingRefSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("durable-object"),
      binding: bindingRefSchema,
      address: durableObjectAddressSchema,
    })
    .strict(),
  dynamicWorkerTargetSchema,
]);

const rpcTargetSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("service"),
      binding: bindingRefSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("durable-object"),
      binding: bindingRefSchema,
      address: durableObjectAddressSchema,
    })
    .strict(),
  dynamicWorkerTargetSchema,
]);

const requestTemplateSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    body: z
      .object({ type: z.literal("json"), from: z.literal("payload") })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if ((request.method === "GET" || request.method === "HEAD") && request.body != null) {
      ctx.addIssue({
        code: "custom",
        message: "GET and HEAD request templates cannot include a body",
        path: ["body"],
      });
    }
  });

const fetchCallSchema = z
  .object({
    type: z.literal("fetch"),
    path: z
      .object({
        base: pathBaseSchema.optional(),
        mode: pathModeSchema.optional(),
      })
      .strict()
      .optional(),
    request: requestTemplateSchema.optional(),
  })
  .strict();

const rpcCallSchema = z
  .object({
    type: z.literal("rpc"),
    method: rpcMethodSchema,
    argsMode: z.enum(["object", "positional"]).optional(),
  })
  .strict();

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
const fetchCallableSchema = z
  .object({
    schema: callableSchemaField,
    target: fetchTargetSchema,
    call: fetchCallSchema.optional(),
  })
  .strict();

const rpcCallableSchema = z
  .object({
    schema: callableSchemaField,
    target: rpcTargetSchema,
    call: rpcCallSchema,
  })
  .strict();

export const CallableSchema = z.union([fetchCallableSchema, rpcCallableSchema]);

/**
 * JSON that names a target capability and an optional call to make against it.
 *
 * Dispatching a Callable resolves live authority from `CallableContext`: public
 * HTTP fetch, Worker bindings, Durable Object namespaces, and Worker Loader
 * bindings are not stored in the descriptor itself. Treat descriptors as
 * untrusted code until the capability-policy task is implemented.
 */
export type Callable = z.infer<typeof CallableSchema>;
export type FetchCallable = z.infer<typeof fetchCallableSchema>;
export type RpcCallable = z.infer<typeof rpcCallableSchema>;
export type DurableObjectAddress = Extract<
  Callable["target"],
  { type: "durable-object" }
>["address"];

export type CallableContext = {
  /**
   * Worker bindings keyed by their runtime binding name. Callables keep only
   * symbolic binding refs (`{ $binding: "NAME" }`), so this object is the
   * only place where a stored Callable can resolve to a live platform
   * capability.
   */
  env?: Record<string, unknown>;
  /**
   * Public HTTP fetch dependency used only by fetch callables targeting
   * `{ type: "http" }`. RPC callables ignore it. Worker-boundary code that
   * wants runtime fetch must pass it explicitly as `{ fetcher: fetch }`; the
   * runtime deliberately does not fall back to ambient global fetch.
   */
  fetcher?: typeof globalThis.fetch;
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
