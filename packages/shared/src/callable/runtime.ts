import {
  CallableError,
  CallableSchema,
  type Callable,
  type CallableContext,
  type DurableObjectAddress,
  type FetchCallable,
  type RpcCallable,
} from "./types.ts";

/**
 * Parses untrusted JSON into the v1 Callable shape.
 *
 * Runtime validation matters because Callables are meant to move through places
 * TypeScript cannot protect: databases, queues, config files, and LLM-generated
 * tool manifests.
 */
export function validateCallable(options: { callable: unknown }) {
  const parsed = CallableSchema.safeParse(options.callable);
  if (!parsed.success) {
    throw new CallableError("DESCRIPTOR_VALIDATION_FAILED", "Invalid callable", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * Builds a Request from a JSON payload using the callable's `requestTemplate`.
 *
 * The default template is intentionally boring: POST the whole payload as JSON.
 * That keeps `dispatchCallable()` useful without making every fetch callable
 * spell out the common case. Explicit templates can still set method,
 * literal headers/query values, and JSON body-from-payload. RFC 6570, JSON-e,
 * JSON Pointer extraction, and pass-through args are intentionally parked in
 * `tasks/` until we have real callers that need them.
 */
export function buildCallableRequest(options: { callable: FetchCallable; payload: unknown }) {
  const callable = validateCallable({ callable: options.callable });
  if (callable.kind !== "fetch") {
    throw new CallableError("DESCRIPTOR_VALIDATION_FAILED", `Unsupported callable kind`);
  }

  const template = callable.requestTemplate ?? {
    method: "POST" as const,
    body: { type: "json" as const, from: "payload" as const },
  };

  const url = buildCallableTemplateUrl({ callable });
  for (const [key, value] of Object.entries(template.query ?? {})) {
    url.searchParams.set(key, String(value));
  }

  const headers = new Headers(template.headers);
  const requestInit: RequestInit = {
    method: template.method,
    headers,
  };

  if (template.body?.type === "json") {
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
}) {
  const callable = validateCallable({ callable: options.callable });

  switch (callable.kind) {
    case "fetch": {
      if (options.payload instanceof Request) {
        throw new CallableError(
          "PAYLOAD_VALIDATION_FAILED",
          "dispatchCallable() does not accept Request payloads; use dispatchCallableFetch() for streaming proxy mode",
        );
      }

      const response = await dispatchCallableFetch({
        callable,
        request: buildCallableRequest({ callable, payload: options.payload }),
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
      return await dispatchCallableRpc({ callable, payload: options.payload, ctx: options.ctx });
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
}) {
  const callable = validateCallable({ callable: options.callable });
  if (callable.kind !== "fetch") {
    throw new CallableError("DESCRIPTOR_VALIDATION_FAILED", `Unsupported callable kind`);
  }
  if (options.request.bodyUsed) {
    throw new CallableError("PAYLOAD_VALIDATION_FAILED", "Request body was already consumed");
  }

  const outboundUrl = buildCallableUrl({
    callable,
    incomingRequestUrl: options.request.url,
  });
  const rewrittenRequest = new Request(outboundUrl, options.request);

  switch (callable.target.type) {
    case "http": {
      /**
       * This is the `globalThis.fetch` fallback. If a
       * caller omits `ctx.fetcher`, public HTTP callables use the Worker/runtime
       * global fetch. That is convenient for trusted Worker-boundary code, but
       * it is ambient authority. Untrusted callables should be dispatched with
       * an explicit policy/resolver instead of relying on this default.
       */
      const fetcher = options.ctx.fetcher ?? globalThis.fetch;
      return await fetcher(rewrittenRequest);
    }
    case "service": {
      /**
       * Service bindings and Durable Object stubs use Fetch semantics, not RPC
       * semantics, for `.fetch()`. Redirect-following on an internal binding
       * can therefore turn a trusted binding call into public egress. Keep
       * internal fetch targets manual by default:
       * https://developers.cloudflare.com/workers/runtime-apis/rpc/reserved-methods/#fetch
       */
      const outboundRequest = new Request(rewrittenRequest, { redirect: "manual" });
      return await resolveServiceBinding({
        bindingName: callable.target.binding.$binding,
        env: options.ctx.env,
      }).fetch(outboundRequest);
    }
    case "durable-object": {
      /**
       * Keep redirect policy aligned with service bindings. DO `fetch()` is an
       * HTTP-shaped invocation; if the object wants a caller to follow a
       * redirect, the caller can inspect the 3xx response and decide.
       */
      const outboundRequest = new Request(rewrittenRequest, { redirect: "manual" });
      const stub = resolveDurableObjectStub({
        bindingName: callable.target.binding.$binding,
        address: callable.target.address,
        env: options.ctx.env,
      });
      if (!isFetchableBinding(stub)) {
        throw new CallableError(
          "RESOLUTION_FAILED",
          `Durable Object binding "${callable.target.binding.$binding}" did not resolve to a fetchable stub`,
        );
      }
      return await stub.fetch(outboundRequest);
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
}) {
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
      { retryable: true },
    );
  }

  if (options.binaryType) response.webSocket.binaryType = options.binaryType;
  response.webSocket.accept(options.accept);
  return response.webSocket;
}

function buildCallableUrl(options: { callable: FetchCallable; incomingRequestUrl: string }) {
  const baseUrl = resolveBaseUrl(options.callable);
  const incoming = new URL(options.incomingRequestUrl);

  if ((options.callable.pathMode ?? "prefix") === "prefix") {
    baseUrl.pathname = joinPathPrefix(baseUrl.pathname, incoming.pathname);
  }

  baseUrl.search = incoming.search;
  return baseUrl;
}

function buildCallableTemplateUrl(options: { callable: FetchCallable }) {
  return resolveBaseUrl(options.callable);
}

function resolveBaseUrl(callable: FetchCallable) {
  switch (callable.target.type) {
    case "http":
      return new URL(callable.target.url);
    case "service":
      return buildSyntheticBaseUrl({
        hostname: "service.local",
        pathPrefix: callable.target.pathPrefix,
      });
    case "durable-object":
      return buildSyntheticBaseUrl({
        hostname: "durable-object.local",
        pathPrefix: callable.target.pathPrefix,
      });
  }
}

function buildSyntheticBaseUrl(options: { hostname: string; pathPrefix: string | undefined }) {
  const url = new URL(`https://${options.hostname}`);
  url.pathname = options.pathPrefix ?? "/";
  return url;
}

function joinPathPrefix(prefix: string, incomingPath: string) {
  const normalizedPrefix = prefix === "/" ? "" : prefix.replace(/\/+$/, "");
  const normalizedIncoming = incomingPath.startsWith("/") ? incomingPath : `/${incomingPath}`;
  const joined = `${normalizedPrefix}${normalizedIncoming}`;
  return joined === "" ? "/" : joined;
}

async function dispatchCallableRpc(options: {
  callable: RpcCallable;
  payload: unknown;
  ctx: CallableContext;
}) {
  const stub = resolveRpcStub({
    target: options.callable.target,
    env: options.ctx.env,
  });
  assertRpcMethodResolvable({
    target: stub,
    methodName: options.callable.rpcMethod,
  });
  const args = buildRpcArgs({
    argsMode: options.callable.argsMode ?? "object",
    payload: options.payload,
  });

  /**
   * Do not wrap remote method errors here. Workers RPC already preserves the
   * remote exception shape as much as the platform can; callers generally need
   * to see that application error rather than a transport-flavored wrapper.
   */
  return await (stub as Record<string, (...args: unknown[]) => unknown>)[
    options.callable.rpcMethod
  ](...args);
}

function resolveRpcStub(options: {
  target: RpcCallable["target"];
  env: Record<string, unknown> | undefined;
}) {
  switch (options.target.type) {
    case "service":
      return resolveBinding({ bindingName: options.target.binding.$binding, env: options.env });
    case "durable-object":
      return resolveDurableObjectStub({
        bindingName: options.target.binding.$binding,
        address: options.target.address,
        env: options.env,
      });
  }
}

function assertRpcMethodResolvable(options: { target: unknown; methodName: string }) {
  if (typeof options.target !== "object" || options.target === null) {
    throw new CallableError("RESOLUTION_FAILED", "RPC target is not an object");
  }

  /**
   * On real Workers RPC stubs, Cloudflare intentionally exposes every possible
   * method name and lets the remote endpoint decide whether it exists. This
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
  const contentType = options.response.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("json")) {
    return await options.response.json();
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

function resolveBinding(options: {
  bindingName: string;
  env: Record<string, unknown> | undefined;
}) {
  if (!options.env || !(options.bindingName in options.env)) {
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
