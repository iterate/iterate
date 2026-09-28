// library/openapi.ts — `itx.connectToOpenApi(specOrUrl, { baseUrl?, headers? })`: an OpenAPI 3
// service as an RpcTarget whose methods are its `operationId`s, written against `itx.fetch` alone.
// Deliberately small: one input OBJECT per
// call — path parameters substitute into the path, query parameters go on the URL, header
// parameters on the request, and what is left is the JSON body when the operation declares one (an
// input whose only key is `body` sends `input.body` verbatim, for a non-object body). A non-2xx
// answer throws with the status and the first 300 characters. The base URL keeps the spec URL's
// query when it falls back to it.

import { RpcTarget } from "capnweb";
import { z } from "zod";
import type {
  OpenApiConnectionApi,
  OpenApiConnectOptions,
  OpenApiDocument,
  OpenApiOperation,
} from "iterate/api";
import type { LibraryItx } from "../library.ts";
import { refuseUnlessOk, subclassWithMethods } from "./connection.ts";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

/** Connect: fetch the document when given a URL, index its operations, and hand back a connection
 *  whose prototype carries one method per `operationId`. */
export async function connectToOpenApi(
  itx: LibraryItx,
  specOrUrl: string | OpenApiDocument,
  options: OpenApiConnectOptions = {},
): Promise<OpenApiConnectionRpcTarget> {
  const specUrl = typeof specOrUrl === "string" ? specOrUrl : undefined;
  const spec =
    typeof specOrUrl === "string" ? await fetchDocument(itx, specOrUrl, options) : specOrUrl;
  if (typeof spec?.openapi !== "string")
    throw new Error(`connectToOpenApi: ${specUrl || "the document"} is not an OpenAPI 3 document`);
  const operations = listOperations(spec);
  const Connection = subclassWithMethods(
    OpenApiConnectionRpcTarget,
    operations.map((operation) => operation.operationId),
    (self, name, input) => self.call(name, input as Record<string, unknown> | undefined),
  );
  return new Connection(
    itx,
    operations,
    requestBase(spec, specUrl, options),
    options.headers || {},
  );
}

/** A connected OpenAPI service. `call(operationId, input)` is the generic entry point; the operations are
 *  its methods too. */
export class OpenApiConnectionRpcTarget extends RpcTarget implements OpenApiConnectionApi {
  readonly #itx: LibraryItx;
  readonly #operations: Map<string, OpenApiOperation>;
  readonly #requestBaseUrl: URL;
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
    this.#requestBaseUrl = base;
    this.#headers = headers;
  }
  /** Every operation the document declares with an `operationId`. */
  operations() {
    return [...this.#operations.values()];
  }
  /** Run one operation: the input object's fields become path, query and header parameters, the
   *  rest the JSON body; the answer is JSON when the response says so, else its text. */
  async call(...[operationId, input]: Parameters<OpenApiConnectionApi["call"]>) {
    const operation = this.#operations.get(operationId);
    if (!operation) throw new Error(`connectToOpenApi: no operation "${operationId}"`);
    const fields = { ...(input || {}) };
    let resolvedPath = operation.path;
    const url = new URL(this.#requestBaseUrl);
    const headers = new Headers(this.#headers);
    const cookieParameters: string[] = [];
    // A parameter value of 0, false or "" is a legal value to send; only null/undefined means the
    // caller did not provide it.
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
          cookieParameters.push(`${parameter.name}=${encodeURIComponent(String(value))}`);
      } else continue;
      delete fields[parameter.name];
    }
    // ONE Cookie header, `; `-joined (RFC 6265) after any cookie the connection's own headers carry
    // — `Headers.append` would join the pairs with `, `, which no server reads as two cookies.
    if (cookieParameters.length > 0)
      headers.set(
        "cookie",
        [headers.get("cookie"), ...cookieParameters].filter(Boolean).join("; "),
      );
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
    await refuseUnlessOk(
      response,
      `${operation.method.toUpperCase()} ${url.pathname} (${operationId})`,
    );
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.includes("json") ? await response.json() : await response.text();
  }
}

async function fetchDocument(
  itx: LibraryItx,
  specUrl: string,
  options: OpenApiConnectOptions,
): Promise<OpenApiDocument> {
  // Auth headers reach the spec only when it lives on the API's host.
  const sameHost = !options.baseUrl || new URL(options.baseUrl).host === new URL(specUrl).host;
  const headers = sameHost ? options.headers || {} : {};
  const response = await refuseUnlessOk(
    await itx.fetch(new Request(specUrl, { headers })),
    `connectToOpenApi: fetching ${specUrl}`,
  );
  return (await response.json()) as OpenApiDocument;
}

/** `baseUrl`, else the document's first server (resolved against the spec URL), else the spec URL
 *  minus its last path segment — QUERY KEPT, so a expression-fetch URL stays addressed. */
function requestBase(
  spec: OpenApiDocument,
  specUrl: string | undefined,
  options: OpenApiConnectOptions,
): URL {
  if (options.baseUrl) return new URL(options.baseUrl);
  const serverUrl = spec.servers?.[0]?.url;
  const relative = serverUrl && !/^[a-z][a-z0-9+.-]*:/i.test(serverUrl);
  if (serverUrl && !(relative && !specUrl)) {
    const base = new URL(serverUrl, specUrl);
    // a RELATIVE server (`/api`, the common spelling) resolved against a expression-fetch spec URL keeps
    // the expression fetch's `?context=&itx=` — dropping it would send every operation to the worker's banner
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

/** A concrete OpenAPI parameter — PARSED, never cast: a `$ref` parameter (or any malformed one) has no
 *  string `name`/`in`, so it fails this and is dropped instead of surfacing as `{ name: undefined }`
 *  that violates OpenApiOperation. An internal `$ref` (a shared `#/components/parameters/…`) is
 *  resolved first; an external ref (a URL or file) stays dropped — this path fetches only the spec. */
const OpenApiParameter = z.object({
  name: z.string(),
  in: z.string(),
  required: z.boolean().optional(),
});

/** Resolve an internal JSON pointer (`#/a/b`, RFC 6901 un-escaping) against the root document;
 *  `undefined` for an external ref or a missing target. */
function resolveInternalRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const segment of ref
    .slice(2)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    // oxlint-disable-next-line iterate/simple-truthiness-check -- node is untrusted JSON (unknown); after the null check it narrows to {} but may still be a string/number, so typeof-object is real validation before indexing
    if (node == null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Follow a `$ref` chain (internal only, cycle-guarded) to the concrete node it names. */
function derefInternal(root: unknown, node: unknown, seen = new Set<string>()): unknown {
  while (
    node != null &&
    // oxlint-disable-next-line iterate/simple-truthiness-check -- node is untrusted JSON (unknown); after the null check it narrows to {} but may still be a string/number, so typeof-object is real validation before reading .$ref
    typeof node === "object" &&
    typeof (node as { $ref?: unknown }).$ref === "string"
  ) {
    const ref = (node as { $ref: string }).$ref;
    if (seen.has(ref)) return undefined; // a ref cycle resolves to nothing, never a hang
    seen.add(ref);
    node = resolveInternalRef(root, ref);
  }
  return node;
}

const concreteParameters = (raw: unknown, spec: unknown): OpenApiOperation["parameters"] =>
  Array.isArray(raw)
    ? raw.flatMap((p) => {
        const parsed = OpenApiParameter.safeParse(derefInternal(spec, p));
        return parsed.success ? [parsed.data] : [];
      })
    : [];

function listOperations(spec: OpenApiDocument): OpenApiOperation[] {
  const operations: OpenApiOperation[] = [];
  for (const [path, rawPathItem] of Object.entries(spec.paths || {})) {
    const pathItem = derefInternal(spec, rawPathItem) as Record<string, unknown> | null;
    // oxlint-disable-next-line iterate/simple-truthiness-check -- pathItem is untrusted JSON cast from derefInternal; the object guard is real validation before Object.entries (typeof null === "object", so the null check is also needed)
    if (!pathItem || typeof pathItem !== "object") continue;
    const pathParameters = concreteParameters(pathItem.parameters, spec);
    for (const [method, raw] of Object.entries(pathItem)) {
      // oxlint-disable-next-line iterate/simple-truthiness-check -- raw is untrusted JSON (unknown) from an OpenAPI path item; the object guard is real validation before casting to Record
      if (!HTTP_METHODS.has(method) || raw == null || typeof raw !== "object") continue;
      const op = raw as Record<string, unknown>;
      if (typeof op.operationId !== "string") continue;
      const own = concreteParameters(op.parameters, spec);
      operations.push({
        operationId: op.operationId,
        method,
        path,
        // An operation's parameter OVERRIDES the path item's of the same (name, in) — the spec's rule.
        parameters: [
          ...pathParameters.filter(
            (inherited) => !own.some((o) => o.name === inherited.name && o.in === inherited.in),
          ),
          ...own,
        ],
        hasRequestBody: !!op.requestBody,
        ...(typeof op.summary === "string" && { summary: op.summary }),
      });
    }
  }
  return operations;
}
