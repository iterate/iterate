import { z } from "zod";

const CALLABLE_SCHEMA = "https://schemas.iterate.com/callable/v1";

const CallableVersion = z.literal(CALLABLE_SCHEMA).optional();
const PathMode = z.enum(["prefix", "replace"]);
type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
const JSONValue: z.ZodType<JSONValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JSONValue),
    z.record(z.string(), JSONValue),
  ]),
);

const JsonataExpression = z.string().min(1);

const TransformInput = z
  .object({
    shallowMerge: z.record(z.string(), JSONValue).optional(),
    jsonata: JsonataExpression.optional(),
  })
  .strict()
  .refine((value) => value.shallowMerge != null || value.jsonata != null, {
    message: "transformInput must include shallowMerge or jsonata",
  });

const PathBase = z
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

const HTTPURL = z.string().refine(
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
  "email",
  "fetch",
  "hasOwnProperty",
  "isPrototypeOf",
  "prototype",
  "propertyIsEnumerable",
  "queue",
  "scheduled",
  "tail",
  "then",
  "toLocaleString",
  "toString",
  "trace",
  "valueOf",
  "webSocketClose",
  "webSocketError",
  "webSocketMessage",
]);

const RPCMethod = z
  .string()
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, {
    message: "RPC call method must be a single JavaScript identifier, not a dotted path",
  })
  .refine((value) => !deniedRpcMethods.has(value), {
    message: "RPC call method uses a reserved or dangerous method name",
  });

const DurableObjectSelector = z.union([
  z.object({ name: z.string().min(1) }).strict(),
  z.object({ id: z.string().min(1) }).strict(),
]);

const DynamicWorkerCode = z
  .object({
    compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    compatibilityFlags: z.array(z.string()).optional(),
    mainModule: z.string().min(1),
    modules: z.record(z.string(), z.string()),
  })
  .strict()
  .superRefine((code, ctx) => {
    if (!Object.prototype.hasOwnProperty.call(code.modules, code.mainModule)) {
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

const DynamicWorkerLoader = z
  .object({
    type: z.literal("get"),
    id: z.string().min(1),
  })
  .strict();

const DynamicWorkerEntrypoint = z
  .object({
    name: z.string().min(1).optional(),
    props: JSONValue.optional(),
  })
  .strict();

const DynamicWorkerVia = z
  .object({
    type: z.literal("env-binding"),
    bindingType: z.literal("dynamic-worker"),
    workerLoaderBindingName: z.string().min(1).optional(),
    workerCode: DynamicWorkerCode,
    loader: DynamicWorkerLoader.optional(),
    entrypoint: DynamicWorkerEntrypoint.optional(),
  })
  .strict();

const ServiceEnvBindingVia = z
  .object({
    type: z.literal("env-binding"),
    bindingType: z.literal("service"),
    bindingName: z.string().min(1),
  })
  .strict();

const DurableObjectEnvBindingVia = z
  .object({
    type: z.literal("env-binding"),
    bindingType: z.literal("durable-object-namespace"),
    bindingName: z.string().min(1),
    durableObject: DurableObjectSelector,
  })
  .strict();

const LoopbackServiceVia = z
  .object({
    type: z.literal("loopback-binding"),
    bindingType: z.literal("service"),
    exportName: z.string().min(1),
    props: JSONValue.optional(),
  })
  .strict();

const LoopbackDurableObjectVia = z
  .object({
    type: z.literal("loopback-binding"),
    bindingType: z.literal("durable-object-namespace"),
    exportName: z.string().min(1),
    durableObject: DurableObjectSelector,
  })
  .strict();

const EnvBindingVia = z.discriminatedUnion("bindingType", [
  ServiceEnvBindingVia,
  DurableObjectEnvBindingVia,
  DynamicWorkerVia,
]);

const LoopbackBindingVia = z.discriminatedUnion("bindingType", [
  LoopbackServiceVia,
  LoopbackDurableObjectVia,
]);

const URLVia = z
  .object({
    type: z.literal("url"),
    url: HTTPURL,
  })
  .strict();

const FetchVia = z.union([URLVia, EnvBindingVia, LoopbackBindingVia]);
const WorkersRpcVia = z.union([EnvBindingVia, LoopbackBindingVia]);

const FetchRequest = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    body: z.object({ jsonata: JsonataExpression }).strict().optional(),
    path: z
      .object({
        base: PathBase.optional(),
        mode: PathMode.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Contract-local callable descriptor schemas keep this package self-contained
 * and browser-safe. The shared callable runtime still performs the same
 * validation before dispatching; this copy exists only for Events wire payloads.
 */
export const FetchCallable = z
  .object({
    type: z.literal("fetch"),
    schema: CallableVersion,
    via: FetchVia,
    transformInput: TransformInput.optional(),
    fetchRequest: FetchRequest.optional(),
  })
  .strict();

const WorkersRpcCallable = z
  .object({
    type: z.literal("workers-rpc"),
    schema: CallableVersion,
    via: WorkersRpcVia,
    rpcMethod: RPCMethod,
    argsMode: z.enum(["object", "positional"]).optional(),
    transformInput: TransformInput.optional(),
  })
  .strict()
  .superRefine((callable, ctx) => {
    if (
      callable.argsMode === "positional" &&
      callable.transformInput?.shallowMerge != null &&
      callable.transformInput.jsonata == null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["transformInput", "shallowMerge"],
        message:
          "positional RPC cannot use transformInput.shallowMerge unless transformInput.jsonata also produces the positional array",
      });
    }
  });

export const Callable = z.discriminatedUnion("type", [FetchCallable, WorkersRpcCallable]);
