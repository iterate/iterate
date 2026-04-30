import jsonata from "jsonata";
import {
  Callable as CallableDefinition,
  CallableError,
  type Callable,
  type CallableContext,
  type DurableObjectSelector,
  type FetchCallable,
  type WorkersRpcCallable,
} from "./types.ts";

type FetchableBinding = { fetch: (request: Request) => Response | Promise<Response> };
type EnvBindingVia = Extract<FetchCallable["via"], { type: "env-binding" }>;
type DynamicWorkerVia = Extract<
  FetchCallable["via"],
  { type: "env-binding"; bindingType: "dynamic-worker" }
>;
type EnvDurableObjectVia = Extract<
  FetchCallable["via"],
  { type: "env-binding"; bindingType: "durable-object-namespace" }
>;
type LoopbackDurableObjectVia = Extract<
  FetchCallable["via"],
  { type: "loopback-binding"; bindingType: "durable-object-namespace" }
>;
type DynamicWorkerCode = DynamicWorkerVia["workerCode"];
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
  const parsed = CallableDefinition.safeParse(options.callable);
  if (!parsed.success) {
    throw new CallableError("DESCRIPTOR_VALIDATION_FAILED", "Invalid callable", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * Validates that a Callable can resolve its named platform capabilities from
 * the concrete dispatch context the caller is about to use.
 *
 * This is intentionally context-aware. For example, `loopback-binding` is valid
 * when the dispatching Worker passes matching `ctx.exports`, but invalid when a
 * different Worker or Durable Object dispatches without those exports.
 */
export function assertCallableDispatchContext(options: {
  callable: unknown;
  ctx: CallableContext;
}): Callable {
  const callable = validateCallable({ callable: options.callable });
  if (callable.type === "fetch") {
    assertFetchCallableContext({ callable, ctx: options.ctx });
  } else {
    assertRpcCallableContext({ callable, ctx: options.ctx });
  }
  return callable;
}

/**
 * Builds the source Request used by value dispatch before the shared Fetch
 * dispatcher applies URL/path metadata.
 *
 * The default is intentionally boring: POST the whole input as JSON.
 * That keeps `dispatchCallable()` useful without making every fetch callable
 * spell out the common case. When a caller needs a different JSON body shape,
 * `fetchRequest.body.jsonata` transforms the input into that body. The lower
 * level `dispatchCallableFetch()` path never runs this because it already
 * receives a complete Request.
 */
async function buildCallableRequest(options: {
  callable: FetchCallable;
  input: unknown;
  ctx: CallableContext;
}): Promise<Request> {
  const callable = options.callable;
  const requestOverrides = callable.fetchRequest ?? {};
  const method = requestOverrides.method ?? "POST";
  const shouldSendJsonBody = !["GET", "HEAD"].includes(method);
  if (!shouldSendJsonBody && requestOverrides.body) {
    throw new CallableError(
      "PAYLOAD_VALIDATION_FAILED",
      "fetchRequest.body cannot be used with GET or HEAD value dispatch",
    );
  }

  /**
   * `dispatchCallable()` intentionally creates a boring synthetic Request and
   * then delegates to `dispatchCallableFetch()`. When `via` is a public
   * URL with a query string, carrying that query into the source request keeps
   * the common "fetch this URL" case literal without teaching the fetch
   * dispatcher a separate value-call path.
   */
  const url = new URL("https://callable.local/");
  if (callable.via.type === "url") {
    url.search = new URL(callable.via.url).search;
  }
  const configuredQuery = requestOverrides.query ?? {};
  if (requestOverrides.query != null) {
    url.search = "";
  }
  for (const [key, value] of Object.entries(configuredQuery)) {
    url.searchParams.set(key, String(value));
  }

  const headers = new Headers(requestOverrides.headers);
  const requestInit: RequestInit = {
    method,
    headers,
  };

  if (shouldSendJsonBody) {
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    const body =
      requestOverrides.body == null
        ? options.input
        : await evaluateJsonata({
            expression: requestOverrides.body.jsonata,
            input: options.input,
            ctx: options.ctx,
          });
    requestInit.body = JSON.stringify(body ?? null);
  }

  return new Request(url, requestInit);
}

/**
 * Dispatches any v1 Callable and returns the produced value.
 *
 * This is the main API for callers that do not care whether the callable is
 * backed by fetch or Workers RPC. Fetch-shaped callables transform the payload
 * into input, build a Request from that input, reject non-2xx responses, and
 * parse JSON/text response bodies. Use `dispatchCallableFetch()` instead when
 * the caller needs raw `Request`/`Response` objects or streaming behavior.
 */
export async function dispatchCallable(options: {
  callable: unknown;
  payload: unknown;
  ctx: CallableContext;
}): Promise<unknown> {
  const callable = validateCallable({ callable: options.callable });
  if (callable.type === "fetch" && options.payload instanceof Request) {
    throw new CallableError(
      "PAYLOAD_VALIDATION_FAILED",
      "dispatchCallable() does not accept Request payloads; use dispatchCallableFetch() for raw fetch dispatch",
    );
  }

  const input = await transformCallableInput({
    callable,
    payload: options.payload,
    ctx: options.ctx,
  });

  switch (callable.type) {
    case "fetch": {
      const response = await dispatchValidatedCallableFetch({
        callable,
        request: await buildCallableRequest({ callable, input, ctx: options.ctx }),
        ctx: options.ctx,
        source: "value",
      });

      if (!response.ok) {
        const body = await response.text();
        throw new CallableError(
          "REMOTE_ERROR",
          `Callable fetch returned ${response.status} ${response.statusText}`,
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
    case "workers-rpc": {
      return await dispatchCallableRpc({ callable, input, ctx: options.ctx });
    }
  }
}

/**
 * Dispatches a fetch-shaped Callable.
 *
 * The important invariant is that raw fetch dispatch never reads the request
 * body. We use `new Request(outboundUrl, request)` because Cloudflare documents
 * cloning a Request as the way to rewrite immutable URL/header state while
 * preserving the rest of the request shape:
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
    source: "request",
  });
}

async function dispatchValidatedCallableFetch(options: {
  callable: FetchCallable;
  request: Request;
  ctx: CallableContext;
  source: "value" | "request";
}): Promise<Response> {
  const callable = options.callable;
  if (options.source === "request" && callable.fetchRequest?.body) {
    throw new CallableError(
      "PAYLOAD_VALIDATION_FAILED",
      "fetchRequest.body is only supported by dispatchCallable() value dispatch",
    );
  }
  if (options.request.bodyUsed) {
    throw new CallableError("PAYLOAD_VALIDATION_FAILED", "Request body was already consumed");
  }

  const rewrittenRequest = buildOutboundFetchRequest({
    callable,
    request: options.request,
  });

  const resolvedFetch = resolveFetchVia({
    callable,
    ctx: options.ctx,
  });

  switch (resolvedFetch.type) {
    case "url": {
      /**
       * Public URL is the one via kind where dispatch needs an explicit fetch
       * capability from the caller. Service, Durable Object, and Dynamic Worker
       * via values resolve from bindings; public egress should not happen just
       * because a shared helper read ambient `globalThis.fetch`.
       */
      return await resolvedFetch.fetch(rewrittenRequest);
    }
    case "binding": {
      /**
       * Service bindings and Durable Object stubs use Fetch semantics, not RPC
       * semantics, for `.fetch()`. Redirect-following on an internal binding
       * can therefore turn a trusted binding call into public egress. Keep
       * internal binding fetches manual by default. Dynamic Worker entrypoints
       * use this same path after their loader binding resolves to a Worker
       * entrypoint:
       * https://developers.cloudflare.com/workers/runtime-apis/rpc/reserved-methods/#fetch
       */
      const outboundRequest = new Request(rewrittenRequest, { redirect: "manual" });
      return await resolvedFetch.fetch.fetch(outboundRequest);
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

async function transformCallableInput(options: {
  callable: Callable;
  payload: unknown;
  ctx: CallableContext;
}) {
  const transform = options.callable.transformInput;
  if (transform == null) {
    return options.payload;
  }
  let input = options.payload;
  if (transform.shallowMerge != null) {
    input = applyShallowMergeInput({
      base: transform.shallowMerge,
      payload: input,
    });
  }
  if (transform.jsonata != null) {
    input = await evaluateJsonata({
      expression: transform.jsonata,
      input,
      ctx: options.ctx,
    });
  }
  return input;
}

function applyShallowMergeInput(options: { base: Record<string, unknown>; payload: unknown }) {
  if (options.payload == null) {
    return { ...options.base };
  }
  if (!isPlainRecord(options.payload)) {
    throw new CallableError(
      "PAYLOAD_VALIDATION_FAILED",
      "transformInput.shallowMerge requires the runtime payload to be an object, null, or undefined",
    );
  }
  return { ...options.base, ...options.payload };
}

async function evaluateJsonata(options: {
  expression: string;
  input: unknown;
  ctx: CallableContext;
}) {
  try {
    const expression = jsonata(options.expression);
    return await expression.evaluate(options.input, {
      ambient: options.ctx.ambient ?? {},
    });
  } catch (error) {
    throw new CallableError("PAYLOAD_VALIDATION_FAILED", "JSONata evaluation failed", {
      cause: error,
    });
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFetchCallable(callable: Callable): callable is FetchCallable {
  return callable.type === "fetch";
}

function validateFetchCallable(options: { callable: unknown }): FetchCallable {
  const callable = validateCallable({ callable: options.callable });
  if (!isFetchCallable(callable)) {
    throw new CallableError("DESCRIPTOR_VALIDATION_FAILED", `Unsupported callable kind`);
  }
  return callable;
}

function buildCallableUrl(options: { callable: FetchCallable; incomingRequestUrl: string }) {
  const baseUrl = resolveBaseUrl(options.callable);
  const incoming = new URL(options.incomingRequestUrl);
  const fetchRequest = options.callable.fetchRequest;
  if (fetchRequest?.path?.base) {
    baseUrl.pathname = fetchRequest.path.base;
  }

  if ((fetchRequest?.path?.mode ?? "prefix") === "prefix") {
    baseUrl.pathname = joinPathPrefix(baseUrl.pathname, incoming.pathname);
  }

  if (fetchRequest?.query != null) {
    baseUrl.search = "";
    for (const [key, value] of Object.entries(fetchRequest.query)) {
      baseUrl.searchParams.set(key, String(value));
    }
  } else {
    baseUrl.search = incoming.search;
  }
  return baseUrl;
}

function buildOutboundFetchRequest(options: { callable: FetchCallable; request: Request }) {
  const fetchRequest = options.callable.fetchRequest;
  const outboundUrl = buildCallableUrl({
    callable: options.callable,
    incomingRequestUrl: options.request.url,
  });
  if (!fetchRequest?.method && !fetchRequest?.headers) {
    return new Request(outboundUrl, options.request);
  }

  const method = fetchRequest.method ?? options.request.method;
  const headers = new Headers(options.request.headers);
  for (const [key, value] of Object.entries(fetchRequest.headers ?? {})) {
    headers.set(key, value);
  }
  const shouldPreserveBody = !["GET", "HEAD"].includes(method);
  const requestInit: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    body: shouldPreserveBody ? options.request.body : null,
    redirect: options.request.redirect,
  };
  if (shouldPreserveBody && options.request.body) {
    requestInit.duplex = "half";
  }
  return new Request(outboundUrl, requestInit);
}

function resolveBaseUrl(callable: FetchCallable) {
  switch (callable.via.type) {
    case "url":
      return new URL(callable.via.url);
    case "env-binding":
      return buildSyntheticBaseUrl({
        hostname: `${callable.via.bindingType}.local`,
      });
    case "loopback-binding":
      return buildSyntheticBaseUrl({
        hostname: `loopback-${callable.via.bindingType}.local`,
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
  callable: WorkersRpcCallable;
  input: unknown;
  ctx: CallableContext;
}) {
  const resolvedRpc = resolveRpcVia({
    callable: options.callable,
    ctx: options.ctx,
  });
  assertRpcMethodResolvable({
    resolvedRpc,
    methodName: options.callable.rpcMethod,
  });
  const args = buildRpcArgs({
    argsMode: options.callable.argsMode ?? "object",
    input: options.input,
  });

  /**
   * Do not wrap remote method errors here. Workers RPC already preserves the
   * remote exception shape as much as the platform can; callers generally need
   * to see that application error rather than a transport-flavored wrapper.
   */
  return await (resolvedRpc as Record<string, (...args: unknown[]) => unknown>)[
    options.callable.rpcMethod
  ](...args);
}

function resolveFetchVia(options: {
  callable: FetchCallable;
  ctx: CallableContext;
}): { type: "url"; fetch: typeof globalThis.fetch } | { type: "binding"; fetch: FetchableBinding } {
  switch (options.callable.via.type) {
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
        via: options.callable.via,
        env: options.ctx.env,
      });
    case "loopback-binding":
      return resolveLoopbackBindingFetchTarget({
        via: options.callable.via,
        exports: options.ctx.exports,
      });
  }
}

function resolveRpcVia(options: { callable: WorkersRpcCallable; ctx: CallableContext }) {
  switch (options.callable.via.type) {
    case "env-binding":
      return resolveEnvBindingRpcTarget({
        via: options.callable.via,
        env: options.ctx.env,
      });
    case "loopback-binding":
      return resolveLoopbackBindingRpcTarget({
        via: options.callable.via,
        exports: options.ctx.exports,
      });
  }
}

function assertRpcMethodResolvable(options: { resolvedRpc: unknown; methodName: string }) {
  if (typeof options.resolvedRpc !== "object" || options.resolvedRpc === null) {
    throw new CallableError(
      "RESOLUTION_FAILED",
      "Workers RPC via value did not resolve to an object",
    );
  }

  /**
   * On real Workers RPC stubs, Cloudflare intentionally exposes every possible
   * method name and lets the remote object decide whether it exists. This
   * check is still useful for plain-object test doubles and invalid bindings,
   * but it is not a method allowlist. The policy task will add that explicitly.
   */
  const method = Reflect.get(options.resolvedRpc, options.methodName);
  if (typeof method !== "function") {
    throw new CallableError(
      "RESOLUTION_FAILED",
      `RPC method "${options.methodName}" was not found on the resolved RPC object`,
    );
  }
}

function assertFetchCallableContext(options: { callable: FetchCallable; ctx: CallableContext }) {
  switch (options.callable.via.type) {
    case "url": {
      if (!options.ctx.fetch) {
        throw new CallableError(
          "RESOLUTION_FAILED",
          "URL callables require ctx.fetch; pass fetch explicitly at the Worker boundary",
        );
      }
      return;
    }
    case "env-binding": {
      switch (options.callable.via.bindingType) {
        case "service":
          resolveServiceBinding({
            bindingName: options.callable.via.bindingName,
            env: options.ctx.env,
          });
          return;
        case "durable-object-namespace":
          resolveDurableObjectFetchStub({
            via: options.callable.via,
            source: "env",
            env: options.ctx.env,
          });
          return;
        case "dynamic-worker":
          assertDynamicWorkerLoaderBinding({
            via: options.callable.via,
            env: options.ctx.env,
          });
          return;
      }
      return;
    }
    case "loopback-binding": {
      switch (options.callable.via.bindingType) {
        case "service": {
          const binding = resolveLoopbackServiceBinding({
            via: options.callable.via,
            exports: options.ctx.exports,
          });
          if (!isFetchableBinding(binding)) {
            throw new CallableError(
              "RESOLUTION_FAILED",
              `Loopback export "${options.callable.via.exportName}" does not expose fetch(request)`,
            );
          }
          return;
        }
        case "durable-object-namespace":
          resolveDurableObjectFetchStub({
            via: options.callable.via,
            source: "loopback",
            exports: options.ctx.exports,
          });
          return;
      }
    }
  }
}

function assertRpcCallableContext(options: { callable: WorkersRpcCallable; ctx: CallableContext }) {
  switch (options.callable.via.type) {
    case "env-binding": {
      switch (options.callable.via.bindingType) {
        case "service": {
          const resolvedRpc = resolveBinding({
            bindingName: options.callable.via.bindingName,
            env: options.ctx.env,
          });
          assertRpcMethodResolvable({
            resolvedRpc,
            methodName: options.callable.rpcMethod,
          });
          return;
        }
        case "durable-object-namespace": {
          const resolvedRpc = resolveDurableObjectStub({
            bindingName: options.callable.via.bindingName,
            durableObject: options.callable.via.durableObject,
            env: options.ctx.env,
          });
          assertRpcMethodResolvable({
            resolvedRpc,
            methodName: options.callable.rpcMethod,
          });
          return;
        }
        case "dynamic-worker":
          assertDynamicWorkerLoaderBinding({
            via: options.callable.via,
            env: options.ctx.env,
          });
          return;
      }
      return;
    }
    case "loopback-binding": {
      switch (options.callable.via.bindingType) {
        case "service": {
          const resolvedRpc = resolveLoopbackServiceBinding({
            via: options.callable.via,
            exports: options.ctx.exports,
          });
          assertRpcMethodResolvable({
            resolvedRpc,
            methodName: options.callable.rpcMethod,
          });
          return;
        }
        case "durable-object-namespace": {
          const resolvedRpc = resolveDurableObjectStubFromNamespace({
            namespace: resolveLoopbackExport({
              exportName: options.callable.via.exportName,
              exports: options.ctx.exports,
            }),
            durableObject: options.callable.via.durableObject,
            description: `Loopback Durable Object export "${options.callable.via.exportName}"`,
          });
          assertRpcMethodResolvable({
            resolvedRpc,
            methodName: options.callable.rpcMethod,
          });
          return;
        }
      }
    }
  }
}

function assertDynamicWorkerLoaderBinding(options: {
  via: DynamicWorkerVia;
  env: Record<string, unknown> | undefined;
}) {
  const workerLoaderBindingName = options.via.workerLoaderBindingName ?? "LOADER";
  const loader = resolveBinding({
    bindingName: workerLoaderBindingName,
    env: options.env,
  });
  if (!isDynamicWorkerLoader(loader)) {
    throw new CallableError(
      "RESOLUTION_FAILED",
      `Binding "${workerLoaderBindingName}" is not a Worker Loader`,
    );
  }
}

function buildRpcArgs(options: { argsMode: "object" | "positional"; input: unknown }) {
  if (options.argsMode === "object") return [options.input];
  if (!Array.isArray(options.input)) {
    throw new CallableError(
      "PAYLOAD_VALIDATION_FAILED",
      "RPC positional argsMode requires the transformed input to be an array",
    );
  }
  return options.input as unknown[];
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
      throw new CallableError("REMOTE_ERROR", "Callable fetch returned invalid JSON", {
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
  via: EnvBindingVia;
  env: Record<string, unknown> | undefined;
}): { type: "binding"; fetch: FetchableBinding } {
  switch (options.via.bindingType) {
    case "service":
      return {
        type: "binding",
        fetch: resolveServiceBinding({
          bindingName: options.via.bindingName,
          env: options.env,
        }),
      };
    case "durable-object-namespace":
      return {
        type: "binding",
        fetch: resolveDurableObjectFetchStub({
          via: options.via,
          source: "env",
          env: options.env,
        }),
      };
    case "dynamic-worker":
      return {
        type: "binding",
        fetch: resolveDynamicWorkerFetchEntrypoint({
          via: options.via,
          env: options.env,
        }),
      };
  }
}

function resolveEnvBindingRpcTarget(options: {
  via: EnvBindingVia;
  env: Record<string, unknown> | undefined;
}) {
  switch (options.via.bindingType) {
    case "service":
      return resolveBinding({
        bindingName: options.via.bindingName,
        env: options.env,
      });
    case "durable-object-namespace":
      return resolveDurableObjectStub({
        bindingName: options.via.bindingName,
        durableObject: options.via.durableObject,
        env: options.env,
      });
    case "dynamic-worker":
      return resolveDynamicWorkerEntrypoint({
        via: options.via,
        env: options.env,
      });
  }
}

function resolveLoopbackBindingFetchTarget(options: {
  via: Extract<FetchCallable["via"], { type: "loopback-binding" }>;
  exports: Record<string, unknown> | undefined;
}): { type: "binding"; fetch: FetchableBinding } {
  switch (options.via.bindingType) {
    case "service": {
      const binding = resolveLoopbackServiceBinding({
        via: options.via,
        exports: options.exports,
      });
      if (!isFetchableBinding(binding)) {
        throw new CallableError(
          "RESOLUTION_FAILED",
          `Loopback export "${options.via.exportName}" does not expose fetch(request)`,
        );
      }
      return { type: "binding", fetch: binding };
    }
    case "durable-object-namespace":
      return {
        type: "binding",
        fetch: resolveDurableObjectFetchStub({
          via: options.via,
          source: "loopback",
          exports: options.exports,
        }),
      };
  }
}

function resolveLoopbackBindingRpcTarget(options: {
  via: Extract<WorkersRpcCallable["via"], { type: "loopback-binding" }>;
  exports: Record<string, unknown> | undefined;
}) {
  switch (options.via.bindingType) {
    case "service":
      return resolveLoopbackServiceBinding({
        via: options.via,
        exports: options.exports,
      });
    case "durable-object-namespace":
      return resolveDurableObjectStubFromNamespace({
        namespace: resolveLoopbackExport({
          exportName: options.via.exportName,
          exports: options.exports,
        }),
        durableObject: options.via.durableObject,
        description: `Loopback Durable Object export "${options.via.exportName}"`,
      });
  }
}

function resolveLoopbackServiceBinding(options: {
  via: Extract<FetchCallable["via"], { type: "loopback-binding"; bindingType: "service" }>;
  exports: Record<string, unknown> | undefined;
}) {
  const binding = resolveLoopbackExport({
    exportName: options.via.exportName,
    exports: options.exports,
  });
  if (options.via.props === undefined) return binding;
  if (typeof binding !== "function") {
    throw new CallableError(
      "RESOLUTION_FAILED",
      `Loopback export "${options.via.exportName}" cannot be parameterized with props`,
    );
  }
  return binding({ props: options.via.props });
}

function resolveDurableObjectFetchStub(
  options:
    | {
        via: EnvDurableObjectVia;
        source: "env";
        env: Record<string, unknown> | undefined;
      }
    | {
        via: LoopbackDurableObjectVia;
        source: "loopback";
        exports: Record<string, unknown> | undefined;
      },
) {
  const stub =
    options.source === "env"
      ? resolveDurableObjectStub({
          bindingName: options.via.bindingName,
          durableObject: options.via.durableObject,
          env: options.env,
        })
      : resolveDurableObjectStubFromNamespace({
          namespace: resolveLoopbackExport({
            exportName: options.via.exportName,
            exports: options.exports,
          }),
          durableObject: options.via.durableObject,
          description: `Loopback Durable Object export "${options.via.exportName}"`,
        });
  if (!isFetchableBinding(stub)) {
    throw new CallableError(
      "RESOLUTION_FAILED",
      "Durable Object via value did not resolve to a fetchable stub",
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
  via: DynamicWorkerVia;
  env: Record<string, unknown> | undefined;
}) {
  const workerLoaderBindingName = options.via.workerLoaderBindingName ?? "LOADER";
  const loader = resolveBinding({
    bindingName: workerLoaderBindingName,
    env: options.env,
  });
  if (!isDynamicWorkerLoader(loader)) {
    throw new CallableError(
      "RESOLUTION_FAILED",
      `Binding "${workerLoaderBindingName}" is not a Worker Loader`,
    );
  }

  /**
   * Dynamic Worker callables keep source code inline for this slice. When the
   * via uses Worker Loader `get`, the ID is a cache key for this exact code
   * version; Cloudflare documents that a loader `get()` callback must keep
   * returning identical code for the same ID:
   * https://developers.cloudflare.com/dynamic-workers/api-reference/#get
   */
  const stub =
    options.via.loader?.type === "get"
      ? loader.get(options.via.loader.id, () => options.via.workerCode)
      : loader.load(options.via.workerCode);

  const entrypointOptions =
    options.via.entrypoint?.props === undefined
      ? undefined
      : { props: options.via.entrypoint.props };
  const entrypoint =
    options.via.entrypoint?.name || entrypointOptions
      ? stub.getEntrypoint(options.via.entrypoint?.name, entrypointOptions)
      : stub.getEntrypoint();
  if (typeof entrypoint !== "object" || entrypoint === null) {
    throw new CallableError("RESOLUTION_FAILED", "Dynamic Worker entrypoint is not an object");
  }
  return entrypoint;
}

function resolveDynamicWorkerFetchEntrypoint(options: {
  via: DynamicWorkerVia;
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
