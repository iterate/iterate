import {
  CallableError,
  CallableSchema,
  type Callable,
  type CallableContext,
  type DurableObjectSelector,
  type FetchCallable,
  type RpcCallable,
} from "./types.ts";

type FetchableBinding = { fetch: (request: Request) => Response | Promise<Response> };
type EnvBindingTarget = Extract<FetchCallable["target"], { type: "env-binding" }>;
type DynamicWorkerTarget = Extract<
  FetchCallable["target"],
  { type: "env-binding"; bindingType: "dynamic-worker-loader" }
>;
type EnvDurableObjectTarget = Extract<
  FetchCallable["target"],
  { type: "env-binding"; bindingType: "durable-object-namespace" }
>;
type LoopbackDurableObjectTarget = Extract<
  FetchCallable["target"],
  { type: "loopback-binding"; bindingType: "durable-object-namespace" }
>;
type DynamicWorkerCode = DynamicWorkerTarget["workerCode"];
type DynamicWorkerStub = {
  getEntrypoint: (name?: string, options?: { props?: unknown }) => unknown;
};
type DynamicWorkerLoader = {
  load: (code: DynamicWorkerCode) => DynamicWorkerStub;
  get: (
    id: string,
    getCode: () => DynamicWorkerCode | Promise<DynamicWorkerCode>,
  ) => DynamicWorkerStub;
};

/**
 * Parses untrusted JSON into the v1 Callable shape.
 *
 * Runtime validation matters because Callables are meant to move through places
 * TypeScript cannot protect: databases, queues, config files, and LLM-generated
 * tool manifests.
 */
export function validateCallable(options: { callable: unknown }): Callable {
  const parsed = CallableSchema.safeParse(options.callable);
  if (!parsed.success) {
    throw new CallableError("DESCRIPTOR_VALIDATION_FAILED", "Invalid callable", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * Builds a Request from a JSON payload using the callable's fetch request
 * options.
 *
 * The default template is intentionally boring: POST the whole payload as JSON.
 * That keeps `dispatchCallable()` useful without making every fetch callable
 * spell out the common case. Explicit templates are partial overrides: setting
 * headers or query does not accidentally drop the default JSON body. RFC 6570,
 * JSON-e, and JSON Pointer extraction are intentionally parked in `tasks/`
 * until we have real callers that need them.
 */
function buildCallableRequest(options: { callable: FetchCallable; payload: unknown }): Request {
  const callable = options.callable;
  const call = getCallableCall({ callable });
  if (call.type !== "fetch") {
    throw new CallableError("DESCRIPTOR_VALIDATION_FAILED", `Unsupported callable kind`);
  }

  const requestOverrides = call.request ?? {};
  const method = requestOverrides.method ?? "POST";
  const shouldSendJsonBody = !["GET", "HEAD"].includes(method);

  /**
   * `dispatchCallable()` intentionally creates a boring synthetic Request and
   * then delegates to `dispatchCallableFetch()`. When the target is a public
   * URL with a query string, carrying that query into the synthetic request
   * keeps the common "fetch this URL" case literal without teaching the fetch
   * dispatcher a separate value-call mode.
   */
  const url = new URL("https://callable.local/");
  if (callable.target.type === "url") {
    url.search = new URL(callable.target.url).search;
  }
  const templateQuery = requestOverrides.query ?? {};
  if (requestOverrides.query != null) {
    url.search = "";
  }
  for (const [key, value] of Object.entries(templateQuery)) {
    url.searchParams.set(key, String(value));
  }

  const headers = new Headers(requestOverrides.headers);
  const requestInit: RequestInit = {
    method,
    headers,
  };

  if (shouldSendJsonBody) {
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    requestInit.body = JSON.stringify(options.payload ?? null);
  }

  return new Request(url, requestInit);
}

/**
 * Dispatches any v1 Callable and returns the produced value.
 *
 * This is the main API for callers that do not care whether the target is
 * backed by fetch or Workers RPC. Fetch-shaped callables synthesize a Request
 * from the payload, reject non-2xx responses, and parse JSON/text response
 * bodies. Use `dispatchCallableFetch()` instead when the caller needs raw
 * `Request`/`Response` objects or streaming proxy behavior.
 */
export async function dispatchCallable(options: {
  callable: unknown;
  payload: unknown;
  ctx: CallableContext;
}): Promise<unknown> {
  const callable = validateCallable({ callable: options.callable });
  const call = getCallableCall({ callable });
  const payload = applyPassthroughArgs({
    call,
    payload: options.payload,
  });

  switch (call.type) {
    case "fetch": {
      if (!isFetchCallable(callable)) {
        throw new CallableError("DESCRIPTOR_VALIDATION_FAILED", `Unsupported callable kind`);
      }
      if (options.payload instanceof Request) {
        throw new CallableError(
          "PAYLOAD_VALIDATION_FAILED",
          "dispatchCallable() does not accept Request payloads; use dispatchCallableFetch() for streaming proxy mode",
        );
      }

      const response = await dispatchValidatedCallableFetch({
        callable,
        request: buildCallableRequest({ callable, payload }),
        ctx: options.ctx,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new CallableError(
          "REMOTE_ERROR",
          `Callable fetch target returned ${response.status} ${response.statusText}`,
          {
            retryable: response.status >= 500,
            details: {
              status: response.status,
              statusText: response.statusText,
              body,
            },
          },
        );
      }

      return await readCallableResponse({ response });
    }
    case "rpc": {
      if (!isRpcCallable(callable)) {
        throw new CallableError("DESCRIPTOR_VALIDATION_FAILED", `Unsupported callable kind`);
      }
      return await dispatchCallableRpc({ callable, payload, ctx: options.ctx });
    }
  }
}

/**
 * Dispatches a fetch-shaped Callable.
 *
 * The important invariant is that proxy mode never reads the request body. We
 * use `new Request(outboundUrl, request)` because Cloudflare documents cloning
 * a Request as the way to rewrite immutable URL/header state while preserving
 * the rest of the request shape:
 * https://developers.cloudflare.com/workers/runtime-apis/request/
 */
export async function dispatchCallableFetch(options: {
  callable: unknown;
  request: Request;
  ctx: CallableContext;
}): Promise<Response> {
  return await dispatchValidatedCallableFetch({
    callable: validateFetchCallable({ callable: options.callable }),
    request: options.request,
    ctx: options.ctx,
  });
}

async function dispatchValidatedCallableFetch(options: {
  callable: FetchCallable;
  request: Request;
  ctx: CallableContext;
}): Promise<Response> {
  const callable = options.callable;
  const call = getCallableCall({ callable });
  if (call.type !== "fetch") {
    throw new CallableError("DESCRIPTOR_VALIDATION_FAILED", `Unsupported callable kind`);
  }
  if (options.request.bodyUsed) {
    throw new CallableError("PAYLOAD_VALIDATION_FAILED", "Request body was already consumed");
  }

  const outboundUrl = buildCallableUrl({
    callable,
    call,
    incomingRequestUrl: options.request.url,
  });
  const rewrittenRequest = new Request(outboundUrl, options.request);

  const target = resolveFetchTarget({
    callable,
    ctx: options.ctx,
  });

  switch (target.type) {
    case "url": {
      /**
       * Public URL is the one target where dispatch needs an explicit fetch
       * capability from the caller. Service, Durable Object, and Dynamic Worker
       * targets resolve from bindings; public egress should not happen just
       * because a shared helper read ambient `globalThis.fetch`.
       */
      return await target.fetch(rewrittenRequest);
    }
    case "binding": {
      /**
       * Service bindings and Durable Object stubs use Fetch semantics, not RPC
       * semantics, for `.fetch()`. Redirect-following on an internal binding
       * can therefore turn a trusted binding call into public egress. Keep
       * internal fetch targets manual by default. Dynamic Worker entrypoints
       * use this same path after their loader binding resolves to a Worker
       * entrypoint:
       * https://developers.cloudflare.com/workers/runtime-apis/rpc/reserved-methods/#fetch
       */
      const outboundRequest = new Request(rewrittenRequest, { redirect: "manual" });
      return await target.fetch.fetch(outboundRequest);
    }
  }
}

/**
 * Opens a caller-side WebSocket through the same Fetchable path.
 *
 * Workers can open outbound WebSockets with `new WebSocket(url)` for public
 * URLs, but this helper uses fetch-with-upgrade because it also works for
 * service bindings and Durable Object stubs. Cloudflare documents the returned
 * `response.webSocket` extension here:
 * https://developers.cloudflare.com/workers/runtime-apis/response/#websocket
 */
export async function connectCallableWebSocket(options: {
  callable: FetchCallable;
  ctx: CallableContext;
  url?: string;
  protocols?: string[];
  headers?: Record<string, string>;
  binaryType?: "blob" | "arraybuffer";
  accept?: { allowHalfOpen?: boolean };
}): Promise<WebSocket> {
  const headers = new Headers(options.headers);
  /**
   * Workers fetch-with-upgrade needs only the Upgrade header from user code.
   * The runtime owns protocol details such as Sec-WebSocket-Key generation:
   * https://developers.cloudflare.com/workers/examples/websockets/#write-a-websocket-client
   */
  headers.set("Upgrade", "websocket");
  if (options.protocols?.length) {
    headers.set("Sec-WebSocket-Protocol", options.protocols.join(", "));
  }

  const response = (await dispatchCallableFetch({
    callable: options.callable,
    request: new Request(toSyntheticRequestUrl(options.url ?? "/"), {
      method: "GET",
      headers,
    }),
    ctx: options.ctx,
  })) as Response & {
    webSocket?:
      | (WebSocket & { accept: (acceptOptions?: { allowHalfOpen?: boolean }) => void })
      | null;
  };

  if (response.status !== 101 || !response.webSocket) {
    throw new CallableError(
      "TRANSPORT_FAILED",
      `WebSocket upgrade failed: ${response.status} ${response.statusText}`,
      {
        retryable: response.status >= 500,
        details: { status: response.status, statusText: response.statusText },
      },
    );
  }

  if (options.binaryType) response.webSocket.binaryType = options.binaryType;
  response.webSocket.accept(options.accept);
  return response.webSocket;
}

function getCallableCall(options: { callable: Callable }) {
  return options.callable.call ?? { type: "fetch" as const };
}

function applyPassthroughArgs(options: {
  call: ReturnType<typeof getCallableCall>;
  payload: unknown;
}) {
  if (!("passthroughArgs" in options.call) || options.call.passthroughArgs == null) {
    return options.payload;
  }
  if (options.payload == null) {
    return { ...options.call.passthroughArgs };
  }
  if (!isPlainRecord(options.payload)) {
    throw new CallableError(
      "PAYLOAD_VALIDATION_FAILED",
      "call.passthroughArgs requires the runtime payload to be an object, null, or undefined",
    );
  }
  return { ...options.call.passthroughArgs, ...options.payload };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRpcCallable(callable: Callable): callable is RpcCallable {
  return callable.call?.type === "rpc";
}

function isFetchCallable(callable: Callable): callable is FetchCallable {
  return callable.call?.type !== "rpc";
}

function validateFetchCallable(options: { callable: unknown }): FetchCallable {
  const callable = validateCallable({ callable: options.callable });
  if (!isFetchCallable(callable)) {
    throw new CallableError("DESCRIPTOR_VALIDATION_FAILED", `Unsupported callable kind`);
  }
  return callable;
}

function buildCallableUrl(options: {
  callable: FetchCallable;
  call: NonNullable<FetchCallable["call"]>;
  incomingRequestUrl: string;
}) {
  const baseUrl = resolveBaseUrl(options.callable);
  const incoming = new URL(options.incomingRequestUrl);
  if (options.call.path?.base) {
    baseUrl.pathname = options.call.path.base;
  }

  if ((options.call.path?.mode ?? "prefix") === "prefix") {
    baseUrl.pathname = joinPathPrefix(baseUrl.pathname, incoming.pathname);
  }

  baseUrl.search = incoming.search;
  return baseUrl;
}

function resolveBaseUrl(callable: FetchCallable) {
  switch (callable.target.type) {
    case "url":
      return new URL(callable.target.url);
    case "env-binding":
      return buildSyntheticBaseUrl({
        hostname: `${callable.target.bindingType}.local`,
      });
    case "loopback-binding":
      return buildSyntheticBaseUrl({
        hostname: `loopback-${callable.target.bindingType}.local`,
      });
  }
}

function buildSyntheticBaseUrl(options: { hostname: string }) {
  const url = new URL(`https://${options.hostname}`);
  url.pathname = "/";
  return url;
}

function joinPathPrefix(prefix: string, incomingPath: string) {
  const normalizedIncoming = incomingPath.startsWith("/") ? incomingPath : `/${incomingPath}`;
  // Root requests preserve the base path exactly, including a trailing slash.
  if (normalizedIncoming === "/") return prefix || "/";
  const normalizedPrefix = prefix === "/" ? "" : prefix.replace(/\/+$/, "");
  const joined = `${normalizedPrefix}${normalizedIncoming}`;
  return joined === "" ? "/" : joined;
}

async function dispatchCallableRpc(options: {
  callable: RpcCallable;
  payload: unknown;
  ctx: CallableContext;
}) {
  const target = resolveRpcTarget({
    callable: options.callable,
    ctx: options.ctx,
  });
  assertRpcMethodResolvable({
    target,
    methodName: options.callable.call.method,
  });
  const args = buildRpcArgs({
    argsMode: options.callable.call.argsMode ?? "object",
    payload: options.payload,
  });

  /**
   * Do not wrap remote method errors here. Workers RPC already preserves the
   * remote exception shape as much as the platform can; callers generally need
   * to see that application error rather than a transport-flavored wrapper.
   */
  return await (target as Record<string, (...args: unknown[]) => unknown>)[
    options.callable.call.method
  ](...args);
}

function resolveFetchTarget(options: {
  callable: FetchCallable;
  ctx: CallableContext;
}): { type: "url"; fetch: typeof globalThis.fetch } | { type: "binding"; fetch: FetchableBinding } {
  switch (options.callable.target.type) {
    case "url": {
      /**
       * Public URL fetch is a capability too. Requiring it in the context keeps
       * this library honest about egress: Worker entrypoints can still pass
       * `{ fetch }`, but helpers never silently reach for a global.
       */
      if (!options.ctx.fetch) {
        throw new CallableError(
          "RESOLUTION_FAILED",
          "URL callables require ctx.fetch; pass fetch explicitly at the Worker boundary",
        );
      }
      return { type: "url", fetch: options.ctx.fetch };
    }
    case "env-binding":
      return resolveEnvBindingFetchTarget({
        target: options.callable.target,
        env: options.ctx.env,
      });
    case "loopback-binding":
      return resolveLoopbackBindingFetchTarget({
        target: options.callable.target,
        exports: options.ctx.exports,
      });
  }
}

function resolveRpcTarget(options: { callable: RpcCallable; ctx: CallableContext }) {
  switch (options.callable.target.type) {
    case "env-binding":
      return resolveEnvBindingRpcTarget({
        target: options.callable.target,
        env: options.ctx.env,
      });
    case "loopback-binding":
      return resolveLoopbackBindingRpcTarget({
        target: options.callable.target,
        exports: options.ctx.exports,
      });
  }
}

function assertRpcMethodResolvable(options: { target: unknown; methodName: string }) {
  if (typeof options.target !== "object" || options.target === null) {
    throw new CallableError("RESOLUTION_FAILED", "RPC target is not an object");
  }

  /**
   * On real Workers RPC stubs, Cloudflare intentionally exposes every possible
   * method name and lets the remote target decide whether it exists. This
   * check is still useful for plain-object test doubles and invalid bindings,
   * but it is not a method allowlist. The policy task will add that explicitly.
   */
  const method = Reflect.get(options.target, options.methodName);
  if (typeof method !== "function") {
    throw new CallableError(
      "RESOLUTION_FAILED",
      `RPC method "${options.methodName}" was not found on target`,
    );
  }
}

function buildRpcArgs(options: { argsMode: "object" | "positional"; payload: unknown }) {
  if (options.argsMode === "object") return [options.payload];
  if (!Array.isArray(options.payload)) {
    throw new CallableError(
      "PAYLOAD_VALIDATION_FAILED",
      "RPC positional argsMode requires the payload to be an array",
    );
  }
  return options.payload as unknown[];
}

async function readCallableResponse(options: { response: Response }) {
  if (options.response.status === 204 || options.response.status === 205) return null;

  const contentType = options.response.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("json")) {
    const text = await options.response.text();
    if (text === "") return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new CallableError("REMOTE_ERROR", "Callable fetch target returned invalid JSON", {
        cause: error,
        details: {
          status: options.response.status,
          statusText: options.response.statusText,
          body: text,
          contentType,
        },
      });
    }
  }
  return await options.response.text();
}

function resolveServiceBinding(options: {
  bindingName: string;
  env: Record<string, unknown> | undefined;
}) {
  const binding = resolveBinding({ bindingName: options.bindingName, env: options.env });
  if (!isFetchableBinding(binding)) {
    throw new CallableError(
      "RESOLUTION_FAILED",
      `Binding "${options.bindingName}" does not expose fetch(request)`,
    );
  }
  return binding;
}

function resolveEnvBindingFetchTarget(options: {
  target: EnvBindingTarget;
  env: Record<string, unknown> | undefined;
}): { type: "binding"; fetch: FetchableBinding } {
  switch (options.target.bindingType) {
    case "service":
      return {
        type: "binding",
        fetch: resolveServiceBinding({
          bindingName: options.target.bindingName,
          env: options.env,
        }),
      };
    case "durable-object-namespace":
      return {
        type: "binding",
        fetch: resolveDurableObjectFetchStub({
          target: options.target,
          source: "env",
          env: options.env,
        }),
      };
    case "dynamic-worker-loader":
      return {
        type: "binding",
        fetch: resolveDynamicWorkerFetchEntrypoint({
          target: options.target,
          env: options.env,
        }),
      };
  }
}

function resolveEnvBindingRpcTarget(options: {
  target: EnvBindingTarget;
  env: Record<string, unknown> | undefined;
}) {
  switch (options.target.bindingType) {
    case "service":
      return resolveBinding({
        bindingName: options.target.bindingName,
        env: options.env,
      });
    case "durable-object-namespace":
      return resolveDurableObjectStub({
        bindingName: options.target.bindingName,
        durableObject: options.target.durableObject,
        env: options.env,
      });
    case "dynamic-worker-loader":
      return resolveDynamicWorkerEntrypoint({
        target: options.target,
        env: options.env,
      });
  }
}

function resolveLoopbackBindingFetchTarget(options: {
  target: Extract<FetchCallable["target"], { type: "loopback-binding" }>;
  exports: Record<string, unknown> | undefined;
}): { type: "binding"; fetch: FetchableBinding } {
  switch (options.target.bindingType) {
    case "service": {
      const binding = resolveLoopbackServiceBinding({
        target: options.target,
        exports: options.exports,
      });
      if (!isFetchableBinding(binding)) {
        throw new CallableError(
          "RESOLUTION_FAILED",
          `Loopback export "${options.target.exportName}" does not expose fetch(request)`,
        );
      }
      return { type: "binding", fetch: binding };
    }
    case "durable-object-namespace":
      return {
        type: "binding",
        fetch: resolveDurableObjectFetchStub({
          target: options.target,
          source: "loopback",
          exports: options.exports,
        }),
      };
  }
}

function resolveLoopbackBindingRpcTarget(options: {
  target: Extract<RpcCallable["target"], { type: "loopback-binding" }>;
  exports: Record<string, unknown> | undefined;
}) {
  switch (options.target.bindingType) {
    case "service":
      return resolveLoopbackServiceBinding({
        target: options.target,
        exports: options.exports,
      });
    case "durable-object-namespace":
      return resolveDurableObjectStubFromNamespace({
        namespace: resolveLoopbackExport({
          exportName: options.target.exportName,
          exports: options.exports,
        }),
        durableObject: options.target.durableObject,
        description: `Loopback Durable Object export "${options.target.exportName}"`,
      });
  }
}

function resolveLoopbackServiceBinding(options: {
  target: Extract<FetchCallable["target"], { type: "loopback-binding"; bindingType: "service" }>;
  exports: Record<string, unknown> | undefined;
}) {
  const binding = resolveLoopbackExport({
    exportName: options.target.exportName,
    exports: options.exports,
  });
  if (options.target.props === undefined) return binding;
  if (typeof binding !== "function") {
    throw new CallableError(
      "RESOLUTION_FAILED",
      `Loopback export "${options.target.exportName}" cannot be parameterized with props`,
    );
  }
  return binding({ props: options.target.props });
}

function resolveDurableObjectFetchStub(
  options:
    | {
        target: EnvDurableObjectTarget;
        source: "env";
        env: Record<string, unknown> | undefined;
      }
    | {
        target: LoopbackDurableObjectTarget;
        source: "loopback";
        exports: Record<string, unknown> | undefined;
      },
) {
  const stub =
    options.source === "env"
      ? resolveDurableObjectStub({
          bindingName: options.target.bindingName,
          durableObject: options.target.durableObject,
          env: options.env,
        })
      : resolveDurableObjectStubFromNamespace({
          namespace: resolveLoopbackExport({
            exportName: options.target.exportName,
            exports: options.exports,
          }),
          durableObject: options.target.durableObject,
          description: `Loopback Durable Object export "${options.target.exportName}"`,
        });
  if (!isFetchableBinding(stub)) {
    throw new CallableError(
      "RESOLUTION_FAILED",
      "Durable Object target did not resolve to a fetchable stub",
    );
  }
  return stub;
}

function resolveDurableObjectStub(options: {
  bindingName: string;
  durableObject: DurableObjectSelector;
  env: Record<string, unknown> | undefined;
}) {
  const namespace = resolveBinding({ bindingName: options.bindingName, env: options.env });
  return resolveDurableObjectStubFromNamespace({
    namespace,
    durableObject: options.durableObject,
    description: `Binding "${options.bindingName}"`,
  });
}

function resolveDurableObjectStubFromNamespace(options: {
  namespace: unknown;
  durableObject: DurableObjectSelector;
  description: string;
}) {
  const namespace = options.namespace;
  if (!isDurableObjectNamespace(namespace)) {
    throw new CallableError(
      "RESOLUTION_FAILED",
      `${options.description} is not a Durable Object namespace`,
      {
        details: {
          valueType: typeof namespace,
          keys:
            (typeof namespace === "object" || typeof namespace === "function") && namespace != null
              ? Object.keys(namespace)
              : [],
        },
      },
    );
  }

  if ("name" in options.durableObject) {
    if ("getByName" in namespace && typeof namespace.getByName === "function") {
      return namespace.getByName(options.durableObject.name);
    }
    return namespace.get(namespace.idFromName(options.durableObject.name));
  }

  try {
    return namespace.get(namespace.idFromString(options.durableObject.id));
  } catch (error) {
    throw new CallableError(
      "RESOLUTION_FAILED",
      `Durable Object id "${options.durableObject.id}" could not be resolved`,
      { cause: error },
    );
  }
}

function resolveDynamicWorkerEntrypoint(options: {
  target: DynamicWorkerTarget;
  env: Record<string, unknown> | undefined;
}) {
  const loader = resolveBinding({
    bindingName: options.target.bindingName,
    env: options.env,
  });
  if (!isDynamicWorkerLoader(loader)) {
    throw new CallableError(
      "RESOLUTION_FAILED",
      `Binding "${options.target.bindingName}" is not a Worker Loader`,
    );
  }

  /**
   * Dynamic Worker callables keep source code inline for this slice. When the
   * target uses Worker Loader `get`, the ID is a cache key for this exact code
   * version; Cloudflare documents that a loader `get()` callback must keep
   * returning identical code for the same ID:
   * https://developers.cloudflare.com/dynamic-workers/api-reference/#get
   */
  const stub =
    options.target.load?.type === "get"
      ? loader.get(options.target.load.id, () => options.target.workerCode)
      : loader.load(options.target.workerCode);

  const entrypointOptions =
    options.target.entrypoint?.props === undefined
      ? undefined
      : { props: options.target.entrypoint.props };
  const entrypoint =
    options.target.entrypoint?.name || entrypointOptions
      ? stub.getEntrypoint(options.target.entrypoint?.name, entrypointOptions)
      : stub.getEntrypoint();
  if (typeof entrypoint !== "object" || entrypoint === null) {
    throw new CallableError("RESOLUTION_FAILED", "Dynamic Worker entrypoint is not an object");
  }
  return entrypoint;
}

function resolveDynamicWorkerFetchEntrypoint(options: {
  target: DynamicWorkerTarget;
  env: Record<string, unknown> | undefined;
}) {
  const entrypoint = resolveDynamicWorkerEntrypoint(options);
  if (!isFetchableBinding(entrypoint)) {
    throw new CallableError(
      "RESOLUTION_FAILED",
      "Dynamic Worker entrypoint does not expose fetch(request)",
    );
  }
  return entrypoint;
}

function resolveBinding(options: {
  bindingName: string;
  env: Record<string, unknown> | undefined;
}) {
  if (!options.env || !Object.prototype.hasOwnProperty.call(options.env, options.bindingName)) {
    throw new CallableError("RESOLUTION_FAILED", `Binding "${options.bindingName}" not found`);
  }
  return options.env[options.bindingName];
}

function resolveLoopbackExport(options: {
  exportName: string;
  exports: Record<string, unknown> | undefined;
}) {
  if (
    !options.exports ||
    !Object.prototype.hasOwnProperty.call(options.exports, options.exportName)
  ) {
    throw new CallableError(
      "RESOLUTION_FAILED",
      `Loopback export "${options.exportName}" not found`,
    );
  }
  return options.exports[options.exportName];
}

function isFetchableBinding(
  value: unknown,
): value is { fetch: (request: Request) => Response | Promise<Response> } {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value != null &&
    "fetch" in value &&
    typeof value.fetch === "function"
  );
}

function isDynamicWorkerLoader(value: unknown): value is DynamicWorkerLoader {
  return (
    typeof value === "object" &&
    value != null &&
    "load" in value &&
    "get" in value &&
    typeof value.load === "function" &&
    typeof value.get === "function"
  );
}

function isDurableObjectNamespace(value: unknown): value is {
  getByName?: (name: string) => object;
  idFromName: (name: string) => unknown;
  idFromString: (id: string) => unknown;
  get: (id: unknown) => object;
} {
  return (
    typeof value === "object" &&
    value != null &&
    "idFromName" in value &&
    "idFromString" in value &&
    "get" in value &&
    typeof value.idFromName === "function" &&
    typeof value.idFromString === "function" &&
    typeof value.get === "function"
  );
}

function toSyntheticRequestUrl(pathOrUrl: string) {
  if (pathOrUrl.startsWith("ws://")) return pathOrUrl.replace(/^ws:/, "http:");
  if (pathOrUrl.startsWith("wss://")) return pathOrUrl.replace(/^wss:/, "https:");
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) return pathOrUrl;
  return new URL(
    pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`,
    "https://callable.local",
  ).toString();
}
