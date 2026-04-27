import {
  CallableError,
  CallableSchema,
  type Callable,
  type CallableFetchContext,
  type DurableObjectAddress,
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
 * V1 deliberately supports only literal headers/query values and JSON body from
 * the whole payload. RFC 6570, JSON-e, JSON Pointer extraction, and
 * pass-through args are intentionally parked in `tasks/` until we have real
 * callers that need them.
 */
export function buildCallableRequest(options: { callable: Callable; payload: unknown }) {
  const callable = validateCallable({ callable: options.callable });
  if (callable.kind !== "fetch") {
    throw new CallableError("DESCRIPTOR_VALIDATION_FAILED", `Unsupported callable kind`);
  }

  const template = callable.requestTemplate;
  if (!template) {
    throw new CallableError(
      "PAYLOAD_VALIDATION_FAILED",
      "Cannot build a Request without requestTemplate",
    );
  }

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
    requestInit.body = JSON.stringify(options.payload);
  }

  return new Request(url, requestInit);
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
  callable: Callable;
  request: Request;
  ctx: CallableFetchContext;
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
  const outboundRequest = new Request(outboundUrl, options.request);

  switch (callable.target.type) {
    case "http": {
      /**
       * This is the `globalThis.fetch` fallback from the review notes. If a
       * caller omits `ctx.fetcher`, public HTTP callables use the Worker/runtime
       * global fetch. That is convenient for trusted Worker-boundary code, but
       * it is ambient authority. Untrusted callables should be dispatched with
       * an explicit policy/resolver instead of relying on this default.
       */
      const fetcher = options.ctx.fetcher ?? globalThis.fetch;
      return await fetcher(outboundRequest);
    }
    case "service": {
      return await resolveServiceBinding({
        bindingName: callable.target.binding.$binding,
        env: options.ctx.env,
      }).fetch(outboundRequest);
    }
    case "durable-object": {
      return await resolveDurableObjectStub({
        bindingName: callable.target.binding.$binding,
        address: callable.target.address,
        env: options.ctx.env,
      }).fetch(outboundRequest);
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
  callable: Callable;
  ctx: CallableFetchContext;
  url?: string;
  protocols?: string[];
  headers?: Record<string, string>;
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
  })) as Response & { webSocket?: (WebSocket & { accept: () => void }) | null };

  if (response.status !== 101 || !response.webSocket) {
    throw new CallableError(
      "TRANSPORT_FAILED",
      `WebSocket upgrade failed: ${response.status} ${response.statusText}`,
      { retryable: true },
    );
  }

  response.webSocket.accept();
  return response.webSocket;
}

function buildCallableUrl(options: {
  callable: Extract<Callable, { kind: "fetch" }>;
  incomingRequestUrl: string;
}) {
  const upstream = resolveBaseUrl(options.callable);
  const incoming = new URL(options.incomingRequestUrl);

  if ((options.callable.target.pathMode ?? "prefix") === "prefix") {
    upstream.pathname = joinPathPrefix(upstream.pathname, incoming.pathname);
  }

  upstream.search = incoming.search;
  return upstream;
}

function buildCallableTemplateUrl(options: { callable: Extract<Callable, { kind: "fetch" }> }) {
  return resolveBaseUrl(options.callable);
}

function resolveBaseUrl(callable: Extract<Callable, { kind: "fetch" }>) {
  switch (callable.target.type) {
    case "http":
      return new URL(callable.target.upstream);
    case "service":
      return new URL(callable.target.pathPrefix ?? "/", "https://service.local");
    case "durable-object":
      return new URL(callable.target.pathPrefix ?? "/", "https://durable-object.local");
  }
}

function joinPathPrefix(prefix: string, incomingPath: string) {
  const normalizedPrefix = prefix === "/" ? "" : prefix.replace(/\/+$/, "");
  const normalizedIncoming = incomingPath.startsWith("/") ? incomingPath : `/${incomingPath}`;
  const joined = `${normalizedPrefix}${normalizedIncoming}`;
  return joined === "" ? "/" : joined;
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
  getByName?: (name: string) => { fetch: (request: Request) => Response | Promise<Response> };
  idFromName: (name: string) => unknown;
  idFromString: (id: string) => unknown;
  get: (id: unknown) => { fetch: (request: Request) => Response | Promise<Response> };
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
