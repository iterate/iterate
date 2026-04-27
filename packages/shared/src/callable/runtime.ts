import {
  CallableError,
  CallableSchema,
  type Callable,
  type CallableContext,
  type DurableObjectAddress,
  type FetchCallable,
  type RpcCallable,
} from "./types.ts";

type FetchableBinding = { fetch: (request: Request) => Response | Promise<Response> };
type DynamicWorkerTarget = Extract<FetchCallable["target"], { type: "dynamic-worker" }>;
type DynamicWorkerCode = DynamicWorkerTarget["code"];
type DynamicWorkerStub = {
  getEntrypoint: () => unknown;
};
type DynamicWorkerLoader = {
  load?: (code: DynamicWorkerCode) => DynamicWorkerStub;
  get: (
    id: string | null,
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
  const callable = validateFetchCallable({ callable: options.callable });
  const call = getCallableCall({ callable });
  if (call.type !== "fetch") {
    throw new CallableError("DESCRIPTOR_VALIDATION_FAILED", `Unsupported callable kind`);
  }

  const requestOverrides = call.request ?? {};
  const method = requestOverrides.method ?? "POST";
  const body = ["GET", "HEAD"].includes(method)
    ? undefined
    : (requestOverrides.body ?? { type: "json" as const, from: "payload" as const });

  /**
   * `dispatchCallable()` intentionally creates a boring synthetic Request and
   * then delegates to `dispatchCallableFetch()`. When the target is a public
   * URL with a query string, carrying that query into the synthetic request
   * keeps the common "fetch this URL" case literal without teaching the fetch
   * dispatcher a separate value-call mode.
   */
  const url = new URL("https://callable.local/");
  if (callable.target.type === "http") {
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

  if (body?.type === "json") {
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
  callable: Callable;
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

      const response = await dispatchCallableFetch({
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
  callable: FetchCallable;
  request: Request;
  ctx: CallableContext;
}): Promise<Response> {
  const callable = validateFetchCallable({ callable: options.callable });
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
    case "http": {
      /**
       * Public HTTP is the one target where dispatch needs an explicit fetch
       * capability from the caller. Service, Durable Object, and Dynamic Worker
       * targets resolve from bindings; public egress should not happen just
       * because a shared helper read ambient `globalThis.fetch`.
       */
      const fetcher = target.fetcher;
      return await fetcher(rewrittenRequest);
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
      return await target.fetcher.fetch(outboundRequest);
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
  headers.set("Connection", "Upgrade");
  headers.set("Upgrade", "websocket");
  headers.set("Sec-WebSocket-Key", createWebSocketKey());
  headers.set("Sec-WebSocket-Version", "13");
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
    case "http":
      return new URL(callable.target.url);
    case "service":
      return buildSyntheticBaseUrl({
        hostname: "service.local",
      });
    case "durable-object":
      return buildSyntheticBaseUrl({
        hostname: "durable-object.local",
      });
    case "dynamic-worker":
      return buildSyntheticBaseUrl({
        hostname: "dynamic-worker.local",
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
}):
  | { type: "http"; fetcher: typeof globalThis.fetch }
  | { type: "binding"; fetcher: FetchableBinding } {
  switch (options.callable.target.type) {
    case "http": {
      /**
       * Public HTTP fetch is a capability too. Requiring it in the context keeps
       * this library honest about egress: Worker entrypoints can still pass
       * `{ fetcher: fetch }`, but helpers never silently reach for a global.
       */
      if (!options.ctx.fetcher) {
        throw new CallableError(
          "RESOLUTION_FAILED",
          "HTTP callables require ctx.fetcher; pass fetch explicitly at the Worker boundary",
        );
      }
      return { type: "http", fetcher: options.ctx.fetcher };
    }
    case "service":
      return {
        type: "binding",
        fetcher: resolveServiceBinding({
          bindingName: options.callable.target.binding.$binding,
          env: options.ctx.env,
        }),
      };
    case "durable-object":
      return {
        type: "binding",
        fetcher: resolveDurableObjectFetchStub({
          target: options.callable.target,
          env: options.ctx.env,
        }),
      };
    case "dynamic-worker":
      return {
        type: "binding",
        fetcher: resolveDynamicWorkerFetchEntrypoint({
          target: options.callable.target,
          env: options.ctx.env,
        }),
      };
  }
}

function resolveRpcTarget(options: { callable: RpcCallable; ctx: CallableContext }) {
  switch (options.callable.target.type) {
    case "service":
      return resolveBinding({
        bindingName: options.callable.target.binding.$binding,
        env: options.ctx.env,
      });
    case "durable-object":
      return resolveDurableObjectStub({
        bindingName: options.callable.target.binding.$binding,
        address: options.callable.target.address,
        env: options.ctx.env,
      });
    case "dynamic-worker":
      return resolveDynamicWorkerEntrypoint({
        target: options.callable.target,
        env: options.ctx.env,
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
    return JSON.parse(text);
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

function resolveDurableObjectFetchStub(options: {
  target: Extract<FetchCallable["target"], { type: "durable-object" }>;
  env: Record<string, unknown> | undefined;
}) {
  const stub = resolveDurableObjectStub({
    bindingName: options.target.binding.$binding,
    address: options.target.address,
    env: options.env,
  });
  if (!isFetchableBinding(stub)) {
    throw new CallableError(
      "RESOLUTION_FAILED",
      `Durable Object binding "${options.target.binding.$binding}" did not resolve to a fetchable stub`,
    );
  }
  return stub;
}

function resolveDurableObjectStub(options: {
  bindingName: string;
  address: DurableObjectAddress;
  env: Record<string, unknown> | undefined;
}) {
  const namespace = resolveBinding({ bindingName: options.bindingName, env: options.env });
  if (!isDurableObjectNamespace(namespace)) {
    throw new CallableError(
      "RESOLUTION_FAILED",
      `Binding "${options.bindingName}" is not a Durable Object namespace`,
    );
  }

  if (options.address.type === "name") {
    if ("getByName" in namespace && typeof namespace.getByName === "function") {
      return namespace.getByName(options.address.name);
    }
    return namespace.get(namespace.idFromName(options.address.name));
  }

  try {
    return namespace.get(namespace.idFromString(options.address.id));
  } catch (error) {
    throw new CallableError(
      "RESOLUTION_FAILED",
      `Durable Object id "${options.address.id}" could not be resolved`,
      { cause: error },
    );
  }
}

function resolveDynamicWorkerEntrypoint(options: {
  target: DynamicWorkerTarget;
  env: Record<string, unknown> | undefined;
}) {
  const loader = resolveBinding({
    bindingName: options.target.loader.$binding,
    env: options.env,
  });
  if (!isDynamicWorkerLoader(loader)) {
    throw new CallableError(
      "RESOLUTION_FAILED",
      `Binding "${options.target.loader.$binding}" is not a Worker Loader`,
    );
  }

  /**
   * Dynamic Worker callables keep source code inline for this slice. When
   * `cache.mode` is `get`, the ID is a cache key for this exact code version;
   * Cloudflare documents that a loader `get()` callback must keep returning
   * identical code for the same ID:
   * https://developers.cloudflare.com/dynamic-workers/api-reference/#get
   */
  const stub =
    options.target.cache?.mode === "get"
      ? loader.get(options.target.cache.id, () => options.target.code)
      : loadDynamicWorker({ loader, code: options.target.code });

  const entrypoint = stub.getEntrypoint();
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

function loadDynamicWorker(options: {
  loader: DynamicWorkerLoader;
  code: DynamicWorkerCode;
}): DynamicWorkerStub {
  if (typeof options.loader.load === "function") {
    return options.loader.load(options.code);
  }

  /**
   * Current Dynamic Workers docs expose `load(code)` for one-off workers, but
   * some generated Worker Loader types in this repo still model that operation
   * as `get(null, getCode)`. Keep `load()` as the preferred path while accepting
   * the platform's documented null-ID one-off load shape:
   * https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/#basic-usage
   */
  return options.loader.get(null, () => options.code);
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

function isFetchableBinding(
  value: unknown,
): value is { fetch: (request: Request) => Response | Promise<Response> } {
  return (
    typeof value === "object" &&
    value != null &&
    "fetch" in value &&
    typeof value.fetch === "function"
  );
}

function isDynamicWorkerLoader(value: unknown): value is DynamicWorkerLoader {
  return (
    typeof value === "object" && value != null && "get" in value && typeof value.get === "function"
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

function createWebSocketKey() {
  const randomBytes = crypto.getRandomValues(new Uint8Array(16));
  const binary = Array.from(randomBytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary);
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
