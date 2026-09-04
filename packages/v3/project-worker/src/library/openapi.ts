// library/openapi.ts — `itx.connectToOpenApi(specOrUrl, { baseUrl?, headers? })`: an OpenAPI 3
// service as an RpcTarget whose methods are its `operationId`s, written against `itx.fetch` alone
// (the library rule, index.ts). Deliberately small, the apps/os shape (rpc-targets.ts
// `executeOperation`): one input OBJECT per call — path parameters substitute into the path, query
// parameters go on the URL, header parameters on the request, and what is left is the JSON body
// when the operation declares one (an input whose only key is `body` sends `input.body` verbatim, for
// a non-object body). A non-2xx answer throws with the status and the first 300 characters. The base
// URL keeps the spec URL's query when it falls back to it, so a service served over the fetch lane
// (`/expression/<path>?context=…&itx=…`) works like any other.

import { RpcTarget } from "capnweb";
import type { LibraryItx } from "./index.ts";

/** Options for `connectToOpenApi`: `baseUrl` overrides the document's first server; `headers` ride on
 *  every operation call (and on the spec fetch only when the spec shares the API's host). */
export type OpenApiConnectOptions = { baseUrl?: string; headers?: Record<string, string> };

/** An OpenAPI 3 document — only `openapi`, `servers` and `paths` are read. */
export type OpenApiDocument = {
  openapi: string;
  servers?: Array<{ url?: string }>;
  paths?: Record<string, Record<string, unknown>>;
};

/** One operation the connection grew a method for. */
export type OpenApiOperation = {
  operationId: string;
  method: string;
  path: string;
  parameters: Array<{ name: string; in: string; required?: boolean }>;
  hasRequestBody: boolean;
  summary?: string;
};

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

/** Connect: fetch the document when given a URL, index its operations, and hand back a connection
 *  whose prototype carries one method per `operationId`. */
export async function connectToOpenApi(
  itx: LibraryItx,
  specOrUrl: string | OpenApiDocument,
  options: OpenApiConnectOptions = {},
): Promise<OpenApiConnection> {
  const specUrl = typeof specOrUrl === "string" ? specOrUrl : undefined;
  const spec =
    typeof specOrUrl === "string" ? await fetchDocument(itx, specOrUrl, options) : specOrUrl;
  if (typeof spec?.openapi !== "string")
    throw new Error(`connectToOpenApi: ${specUrl ?? "the document"} is not an OpenAPI 3 document`);
  const operations = listOperations(spec);
  const Connection = withOperationMethods(operations);
  return new Connection(
    itx,
    operations,
    requestBase(spec, specUrl, options),
    options.headers ?? {},
  );
}

/** A connected OpenAPI service. `call(operationId, input)` is the generic door; the operations are
 *  its methods too. */
export class OpenApiConnection extends RpcTarget {
  readonly #itx: LibraryItx;
  readonly #operations: Map<string, OpenApiOperation>;
  readonly #base: URL;
  readonly #headers: Record<string, string>;
  constructor(
    itx: LibraryItx,
    operations: OpenApiOperation[],
    base: URL,
    headers: Record<string, string>,
  ) {
    super();
    this.#itx = itx;
    this.#operations = new Map(operations.map((operation) => [operation.operationId, operation]));
    this.#base = base;
    this.#headers = headers;
  }
  /** Every operation the document declares with an `operationId`. */
  operations(): OpenApiOperation[] {
    return [...this.#operations.values()];
  }
  /** Run one operation: the input object's fields become path, query and header parameters, the
   *  rest the JSON body; the answer is JSON when the response says so, else its text. */
  async call(operationId: string, input?: Record<string, unknown>): Promise<unknown> {
    const operation = this.#operations.get(operationId);
    if (!operation) throw new Error(`connectToOpenApi: no operation "${operationId}"`);
    const fields = { ...(input ?? {}) };
    let resolvedPath = operation.path;
    const url = new URL(this.#base);
    const headers = new Headers(this.#headers);
    for (const parameter of operation.parameters) {
      const value = fields[parameter.name];
      if (parameter.in === "path") {
        if (value == null) throw new Error(`${operationId} needs "${parameter.name}"`);
        resolvedPath = resolvedPath.replaceAll(
          `{${parameter.name}}`,
          encodeURIComponent(String(value)),
        );
      } else if (parameter.in === "query") {
        if (value == null && parameter.required)
          throw new Error(`${operationId} needs query parameter "${parameter.name}"`);
        if (value != null) url.searchParams.set(parameter.name, String(value));
      } else if (parameter.in === "header") {
        if (value != null) headers.set(parameter.name, String(value));
      } else if (parameter.in === "cookie") {
        if (value != null)
          headers.append("cookie", `${parameter.name}=${encodeURIComponent(String(value))}`);
      } else continue;
      delete fields[parameter.name];
    }
    url.pathname = url.pathname.replace(/\/$/, "") + resolvedPath;
    const leftover = Object.keys(fields);
    let body: string | undefined;
    if (operation.hasRequestBody) {
      if (leftover.length > 0) {
        body = JSON.stringify(leftover.length === 1 && "body" in fields ? fields.body : fields);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      }
    } else if (leftover.length > 0) {
      throw new Error(
        `${operationId} has no request body and got unknown input key${leftover.length > 1 ? "s" : ""} ${leftover.map((k) => JSON.stringify(k)).join(", ")}`,
      );
    }
    const response = await this.#itx.fetch(
      new Request(url, { method: operation.method.toUpperCase(), headers, body }),
    );
    if (!response.ok) {
      const snippet = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(
        `${operation.method.toUpperCase()} ${url.pathname} (${operationId}) returned ${response.status}${snippet ? `: ${snippet}` : ""}`,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.includes("json") ? await response.json() : await response.text();
  }
}

// `then` is reserved so an operation so named can never make the connection THENABLE (see mcp.ts).
const RESERVED_MEMBERS = new Set(["constructor", "then", "operations", "call"]);

/** A per-connection subclass whose PROTOTYPE carries one method per operation (prototype methods are
 *  what Workers RPC and capnweb traverse — see mcp.ts). */
function withOperationMethods(operations: OpenApiOperation[]): typeof OpenApiConnection {
  const Connection = class extends OpenApiConnection {};
  for (const { operationId } of operations) {
    if (RESERVED_MEMBERS.has(operationId) || !/^[A-Za-z_$][\w$]*$/.test(operationId)) continue;
    Object.defineProperty(Connection.prototype, operationId, {
      value(this: OpenApiConnection, input?: Record<string, unknown>) {
        return this.call(operationId, input);
      },
      writable: true,
      configurable: true,
    });
  }
  return Connection;
}

async function fetchDocument(
  itx: LibraryItx,
  specUrl: string,
  options: OpenApiConnectOptions,
): Promise<OpenApiDocument> {
  // auth headers reach the spec only when it lives on the API's host (apps/os `specFetchHeaders`)
  const apiHost = options.baseUrl ? new URL(options.baseUrl).host : new URL(specUrl).host;
  const headers = new URL(specUrl).host === apiHost ? (options.headers ?? {}) : {};
  const response = await itx.fetch(new Request(specUrl, { headers }));
  if (!response.ok)
    throw new Error(`connectToOpenApi: fetching ${specUrl} returned ${response.status}`);
  return (await response.json()) as OpenApiDocument;
}

/** `baseUrl`, else the document's first server (resolved against the spec URL), else the spec URL
 *  minus its last path segment — QUERY KEPT, so a fetch-lane URL stays addressed. */
function requestBase(
  spec: OpenApiDocument,
  specUrl: string | undefined,
  options: OpenApiConnectOptions,
): URL {
  if (options.baseUrl) return new URL(options.baseUrl);
  const serverUrl = spec.servers?.[0]?.url;
  const relative = serverUrl !== undefined && !/^[a-z][a-z0-9+.-]*:/i.test(serverUrl);
  if (serverUrl && !(relative && !specUrl)) {
    const base = new URL(serverUrl, specUrl);
    // a RELATIVE server (`/api`, the common spelling) resolved against a fetch-lane spec URL keeps
    // the lane's `?context=&itx=` — dropping it would send every operation to the worker's banner
    if (relative && specUrl) base.search = new URL(specUrl).search;
    return base;
  }
  if (!specUrl)
    throw new Error(
      `connectToOpenApi: a document ${serverUrl ? `whose server is the relative ${JSON.stringify(serverUrl)}` : "without servers"} needs { baseUrl }`,
    );
  const base = new URL(specUrl);
  base.pathname = base.pathname.replace(/\/[^/]*$/, "");
  return base;
}

function listOperations(spec: OpenApiDocument): OpenApiOperation[] {
  const operations: OpenApiOperation[] = [];
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    if (pathItem == null || typeof pathItem !== "object") continue;
    const pathParameters = Array.isArray(pathItem.parameters)
      ? (pathItem.parameters as OpenApiOperation["parameters"])
      : [];
    for (const [method, raw] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || raw == null || typeof raw !== "object") continue;
      const op = raw as Record<string, unknown>;
      if (typeof op.operationId !== "string") continue;
      const own = Array.isArray(op.parameters)
        ? (op.parameters as OpenApiOperation["parameters"])
        : [];
      operations.push({
        operationId: op.operationId,
        method,
        path,
        parameters: [...pathParameters, ...own].map((p) => ({
          name: p.name,
          in: p.in,
          ...(p.required !== undefined && { required: p.required }),
        })),
        hasRequestBody: op.requestBody != null,
        ...(typeof op.summary === "string" && { summary: op.summary }),
      });
    }
  }
  return operations;
}
