// OpenApiClient: any OpenAPI 3.x API as an ergonomic first-party capability.
//
// Like McpClient, this is an ordinary RPC target behind a loopback ref —
// parameterized per API by props, with NO powers a user-space equivalent
// couldn't have:
//
//   await itx.provideCapability({
//     name: "petstore",
//     capability: {
//       type: "rpc", worker: { type: "loopback" }, entrypoint: "OpenApiClient",
//       props: {
//         specUrl: "https://petstore3.swagger.io/api/v3/openapi.json",
//         headers: { authorization: 'Bearer getSecret({ key: "PETSTORE_TOKEN" })' },
//       },
//     },
//   });
//
//   await itx.petstore.findPetsByStatus({ status: "available" });
//   await itx.petstore.listOperations();
//
// Dispatch is by FLAT operationId (path = [operationId]) — see
// listOpenApiOperations for why a nested tag.operationId convention loses.
// args[0] is ONE object merging path params + query params + body properties
// (a non-object body travels under the single `body` key) — exactly the
// shape the derived `types` string declares.
//
// Every HTTP request — the spec fetch included — rides PROJECT EGRESS via
// this cap's own itx handle (Law 5), so getSecret(...) placeholders in
// `headers` are substituted inside the egress pipe and never exist here.
//
// Self-description: `describeItx` answers { types, instructions } derived
// from the spec — the provide-time hook in the core (itx.ts) journals them
// so describe() carries the full typed surface with zero callsite ceremony.

import { WorkerEntrypoint } from "cloudflare:workers";
import { resolveItx } from "../entrypoint.ts";
import type { ItxRuntime } from "../handle.ts";
import type { PathCall } from "../itx.ts";
import {
  deriveOpenApiTypes,
  isObjectSchema,
  listOpenApiOperations,
  operationBodySchema,
  type OpenApiOperation,
} from "./openapi-types.ts";

export type OpenApiClientProps = {
  /** Where the OpenAPI 3.x document lives. Provider-supplied. */
  specUrl: string;
  /** Overrides the spec's first `servers` entry as the request base. */
  baseUrl?: string;
  /** Sent on every request (spec fetch included); values pass through egress
   * secret substitution. */
  headers?: Record<string, string>;
  /** Attribution, injected by the dial. */
  capabilityPath?: string;
  context?: string;
  projectId?: string;
};

/** Specs are immutable-enough documents: memoize per isolate with a TTL —
 * the same discipline as the source-build memo (warm key, no fetch). Keyed
 * by project too: the fetch rides a project's egress (its headers, its
 * secrets), so two projects never share an entry. */
const SPEC_CACHE_TTL_MS = 5 * 60_000;
const specCache = new Map<string, { fetchedAtMs: number; spec: Record<string, unknown> }>();

export class OpenApiClient extends WorkerEntrypoint<Env, OpenApiClientProps> {
  async call(input: PathCall): Promise<unknown> {
    const props = this.ctx.props;
    if (!props.specUrl) {
      throw new Error("OpenApiClient needs props.specUrl (the OpenAPI document).");
    }
    if (!props.context) {
      // The dial always injects context; refusing without it means this
      // client can never fetch outside the egress pipe.
      throw new Error("OpenApiClient needs context attribution to route egress.");
    }

    const itx = await resolveItx({
      env: this.env,
      exports: this.ctx.exports as unknown as ItxRuntime["exports"],
      props: { capabilityPath: props.capabilityPath, context: props.context },
    });
    const egressFetch = (request: Request) => itx.fetch(request);
    const spec = await fetchSpec(props, egressFetch);

    const method = input.path.join(".");
    if (method === "describeItx") {
      const info = (spec.info ?? {}) as { title?: string; version?: string };
      const name = props.capabilityPath ?? "<cap>";
      return {
        instructions:
          `${info.title ?? "An OpenAPI API"}${info.version ? ` v${info.version}` : ""}: ` +
          `call itx.${name}.<operationId>({ ...pathParams, ...queryParams, ...body }); ` +
          `itx.${name}.listOperations() lists every operation.`,
        types: deriveOpenApiTypes(spec),
      };
    }
    if (method === "listOperations") {
      return listOpenApiOperations(spec).map((operation) => ({
        method: operation.method,
        operationId: operation.operationId,
        path: operation.path,
        summary: operation.summary ?? null,
      }));
    }

    const operationId = input.path[0];
    if (!operationId || input.path.length > 1) {
      const name = props.capabilityPath ?? "<cap>";
      throw new Error(
        `Call operations by operationId only: itx.${name}.<operationId>(input) — there are ` +
          `no nested paths (got "${input.path.join(".")}"). listOperations() lists what exists.`,
      );
    }
    const operation = listOpenApiOperations(spec).find(
      (candidate) => candidate.operationId === operationId,
    );
    if (!operation) {
      throw new Error(
        `Operation "${operationId}" is not in the OpenAPI spec at ${props.specUrl}. ` +
          `listOperations() lists what exists.`,
      );
    }
    return await executeOperation({ egressFetch, input: input.args[0], operation, props, spec });
  }
}

async function fetchSpec(
  props: OpenApiClientProps,
  egressFetch: (request: Request) => Promise<Response>,
): Promise<Record<string, unknown>> {
  const cacheKey = `${props.projectId ?? ""}:${props.specUrl}`;
  const cached = specCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAtMs < SPEC_CACHE_TTL_MS) return cached.spec;
  // props.headers are API credentials (real material by the time egress has
  // substituted them) — they ride the spec fetch ONLY when the spec lives on
  // the API host itself, never to a third-party spec host.
  const specHost = new URL(props.specUrl).host;
  const apiHost = props.baseUrl ? new URL(props.baseUrl).host : specHost;
  const response = await egressFetch(
    new Request(props.specUrl, { headers: specHost === apiHost ? (props.headers ?? {}) : {} }),
  );
  if (!response.ok) {
    throw new Error(`Fetching the OpenAPI spec at ${props.specUrl} returned ${response.status}.`);
  }
  const spec = (await response.json()) as Record<string, unknown>;
  specCache.set(cacheKey, { fetchedAtMs: Date.now(), spec });
  return spec;
}

/**
 * Execute one operation. The input convention (mirrored exactly by the
 * derived `types` string): args[0] is ONE object whose keys are consumed by
 * path/query parameter NAME first; whatever remains is the JSON body (a
 * non-object body schema travels under the single `body` key). Collisions
 * resolve to the PARAMETER — a body property sharing a name with a path or
 * query parameter cannot be expressed inline. Query values stringify via
 * String(): arrays comma-join (style=form, explode=false); repeated query
 * keys are never emitted. An operation with no request body refuses leftover
 * keys instead of silently dropping them.
 */
async function executeOperation(args: {
  egressFetch: (request: Request) => Promise<Response>;
  input: unknown;
  operation: OpenApiOperation;
  props: OpenApiClientProps;
  spec: Record<string, unknown>;
}): Promise<unknown> {
  const { operation, props, spec } = args;
  const input =
    args.input != null && typeof args.input === "object" && !Array.isArray(args.input)
      ? { ...(args.input as Record<string, unknown>) }
      : {};

  let resolvedPath = operation.path;
  const query: Array<[string, string]> = [];
  for (const parameter of operation.parameters) {
    const value = input[parameter.name];
    if (parameter.in === "path") {
      if (value == null) {
        throw new Error(`Operation "${operation.operationId}" needs "${parameter.name}".`);
      }
      resolvedPath = resolvedPath.replaceAll(
        `{${parameter.name}}`,
        encodeURIComponent(String(value)),
      );
      delete input[parameter.name];
    } else if (parameter.in === "query") {
      // Consumed by name even when absent/null — a null optional query param
      // is simply not sent, never mistaken for a body property. A missing
      // REQUIRED one fails here, locally and instructively, exactly like a
      // missing path param — not as a remote API error.
      if (value == null && parameter.required) {
        throw new Error(
          `Operation "${operation.operationId}" needs query parameter "${parameter.name}".`,
        );
      }
      if (value != null) query.push([parameter.name, String(value)]);
      delete input[parameter.name];
    }
  }
  if (!operation.requestBody) {
    const leftover = Object.keys(input);
    if (leftover.length > 0) {
      const valid = operation.parameters
        .filter((parameter) => parameter.in === "path" || parameter.in === "query")
        .map((parameter) => parameter.name);
      throw new Error(
        `Operation "${operation.operationId}" has no request body and got unknown input ` +
          `key${leftover.length > 1 ? "s" : ""} ${leftover.map((key) => JSON.stringify(key)).join(", ")} — ` +
          (valid.length > 0 ? `valid params: ${valid.join(", ")}.` : `it takes no parameters.`),
      );
    }
  }
  const url = new URL(resolvedPath.replace(/^\//, ""), requestBase(props, spec));
  for (const [name, value] of query) url.searchParams.set(name, value);

  let body: string | undefined;
  if (operation.requestBody && Object.keys(input).length > 0) {
    // The SPEC decides the convention (same split the derived types declare):
    // a non-object body schema travels under the single `body` key; an
    // object schema's properties arrive inline as the leftover object.
    const single =
      Object.keys(input).length === 1 &&
      "body" in input &&
      !isObjectSchema(operationBodySchema(operation, spec));
    body = JSON.stringify(single ? input.body : input);
  }
  const headers = new Headers(props.headers ?? {});
  if (body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await args.egressFetch(
    new Request(url, { body, headers, method: operation.method.toUpperCase() }),
  );
  if (!response.ok) {
    const snippet = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(
      `${operation.method.toUpperCase()} ${url.pathname} (${operation.operationId}) ` +
        `returned ${response.status}${snippet ? `: ${snippet}` : ""}`,
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("json") ? await response.json() : await response.text();
}

/** props.baseUrl, else the spec's first server (relative servers resolve
 * against the spec URL — petstore's "/api/v3" does this), else the spec origin. */
function requestBase(props: OpenApiClientProps, spec: Record<string, unknown>): string {
  if (props.baseUrl) return ensureTrailingSlash(props.baseUrl);
  const servers = spec.servers as Array<{ url?: string }> | undefined;
  const serverUrl = servers?.[0]?.url;
  if (serverUrl) return ensureTrailingSlash(new URL(serverUrl, props.specUrl).toString());
  return new URL("/", props.specUrl).toString();
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
