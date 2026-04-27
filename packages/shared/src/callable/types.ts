import { z } from "zod";

export const CALLABLE_SCHEMA = "https://schemas.iterate.com/callable/v1" as const;

const bindingRefSchema = z.object({ $binding: z.string().min(1) }).strict();

const pathModeSchema = z.enum(["prefix", "replace"]);
const callableSchemaField = z.literal(CALLABLE_SCHEMA).optional();

/**
 * Service bindings and Durable Object stubs are not URL-authorized resources;
 * the binding object is the authority. `pathPrefix` names only the synthetic
 * request path visible to the callee's `fetch(request)` handler, which is why
 * non-HTTP fetch targets do not accept a public `url`.
 */
const pathPrefixSchema = z
  .string()
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !value.includes("?") &&
      !value.includes("#"),
    {
      message:
        "pathPrefix must start with one / and must not be protocol-relative or include query/hash",
    },
  );

const httpUrlSchema = z.string().refine(
  (value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  },
  {
    message:
      "url must be an absolute http(s) URL without query or hash; query modes are future work",
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
  "__proto__",
  "alarm",
  "connect",
  "constructor",
  "dup",
  "fetch",
  "prototype",
  "then",
  "webSocketClose",
  "webSocketError",
  "webSocketMessage",
]);

const rpcMethodSchema = z
  .string()
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, {
    message: "rpcMethod must be a single JavaScript identifier, not a dotted path",
  })
  .refine((value) => !deniedRpcMethods.has(value), {
    message: "rpcMethod uses a reserved or dangerous method name",
  });

const durableObjectAddressSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("name"), name: z.string().min(1) }).strict(),
  z.object({ type: z.literal("id"), id: z.string().min(1) }).strict(),
]);

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
      pathPrefix: pathPrefixSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("durable-object"),
      binding: bindingRefSchema,
      address: durableObjectAddressSchema,
      pathPrefix: pathPrefixSchema.optional(),
    })
    .strict(),
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
]);

const requestTemplateSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    body: z.object({ type: z.literal("json"), from: z.literal("payload") }).optional(),
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
export const CallableSchema = z.discriminatedUnion("kind", [
  z
    .object({
      schema: callableSchemaField,
      kind: z.literal("fetch"),
      target: fetchTargetSchema,
      pathMode: pathModeSchema.optional(),
      requestTemplate: requestTemplateSchema.optional(),
    })
    .strict(),
  z
    .object({
      schema: callableSchemaField,
      kind: z.literal("rpc"),
      target: rpcTargetSchema,
      rpcMethod: rpcMethodSchema,
      argsMode: z.enum(["object", "positional"]).optional(),
    })
    .strict(),
]);

export type Callable = z.infer<typeof CallableSchema>;
export type FetchCallable = Extract<Callable, { kind: "fetch" }>;
export type RpcCallable = Extract<Callable, { kind: "rpc" }>;
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
   * `{ type: "http" }`. RPC callables ignore it. Tests should usually inject
   * this. Production Worker boundaries can omit it and use `globalThis.fetch`,
   * but doing so grants ambient public egress to any HTTP Callable they
   * dispatch.
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
