import { z } from "zod";

const bindingRefSchema = z.object({ $binding: z.string().min(1) }).strict();

const pathModeSchema = z.enum(["prefix", "replace"]);

/**
 * Service bindings and Durable Object stubs are not URL-authorized resources;
 * the binding object is the authority. `pathPrefix` names only the synthetic
 * request path visible to the callee's `fetch(request)` handler, which is why
 * non-HTTP targets do not accept `upstream`.
 */
const pathPrefixSchema = z
  .string()
  .refine((value) => value.startsWith("/") && !value.includes("?") && !value.includes("#"), {
    message: "pathPrefix must start with / and must not include query or hash",
  });

const httpUpstreamSchema = z.string().refine(
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
      "upstream must be an absolute http(s) URL without query or hash; query modes are future work",
  },
);

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
      schemaVersion: z.literal("callable/v1"),
      kind: z.literal("fetch"),
      target: z.discriminatedUnion("type", [
        z
          .object({
            type: z.literal("http"),
            upstream: httpUpstreamSchema,
            pathMode: pathModeSchema.optional(),
          })
          .strict(),
        z
          .object({
            type: z.literal("service"),
            binding: bindingRefSchema,
            pathPrefix: pathPrefixSchema.optional(),
            pathMode: pathModeSchema.optional(),
          })
          .strict(),
        z
          .object({
            type: z.literal("durable-object"),
            binding: bindingRefSchema,
            address: z.discriminatedUnion("type", [
              z.object({ type: z.literal("name"), name: z.string().min(1) }).strict(),
              z.object({ type: z.literal("id"), id: z.string().min(1) }).strict(),
            ]),
            pathPrefix: pathPrefixSchema.optional(),
            pathMode: pathModeSchema.optional(),
          })
          .strict(),
      ]),
      requestTemplate: z
        .object({
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
          headers: z.record(z.string(), z.string()).optional(),
          query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
          body: z.object({ type: z.literal("json"), from: z.literal("payload") }).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);

export type Callable = z.infer<typeof CallableSchema>;
export type FetchCallable = Extract<Callable, { kind: "fetch" }>;
export type DurableObjectAddress = Extract<
  FetchCallable["target"],
  { type: "durable-object" }
>["address"];

export type CallableFetchContext = {
  /**
   * Worker bindings keyed by their runtime binding name. Callables keep only
   * symbolic binding refs (`{ $binding: "NAME" }`), so this object is the
   * only place where a stored Callable can resolve to a live platform
   * capability.
   */
  env?: Record<string, unknown>;
  /**
   * Public HTTP fetch dependency. Tests should usually inject this. Production
   * Worker boundaries can omit it and use `globalThis.fetch`, but doing so
   * grants ambient public egress to any HTTP Callable they dispatch.
   */
  fetcher?: typeof globalThis.fetch;
};

export type CallableErrorCode =
  | "DESCRIPTOR_VALIDATION_FAILED"
  | "PAYLOAD_VALIDATION_FAILED"
  | "RESOLUTION_FAILED"
  | "TRANSPORT_FAILED";

export class CallableError extends Error {
  readonly code: CallableErrorCode;
  readonly retryable: boolean;
  readonly cause: unknown;

  constructor(
    code: CallableErrorCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "CallableError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
  }
}
