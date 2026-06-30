import { RpcTarget } from "cloudflare:workers";
import type {
  CapabilityDescriptionMetadata,
  OpenApiCollection,
  OpenApiConnectInput,
  OpenApiRpc,
} from "../../types.ts";
import { replayPath } from "./live-capability.ts";
import { withInvokeCapabilityFallback } from "./utils.ts";
import {
  deriveOpenApiCapabilityTypes,
  isObjectSchema,
  listOpenApiOperations,
  operationBodySchema,
  type OpenApiOperation,
} from "./openapi-types.ts";

// First-party OpenAPI is just an RpcTarget hosted by Project. The only special
// power it receives is project egress, which is also the path a user-provided
// dynamic worker would use through env.ITX. That keeps the built-in and dynamic
// implementations aligned: fetch spec, derive describe(), then dispatch calls.
type OpenApiDeps = { egress: Fetcher };

export class OpenApiCollectionRpcTarget extends RpcTarget implements OpenApiCollection {
  constructor(readonly props: OpenApiDeps) {
    super();
  }

  connect(input: OpenApiConnectInput): Promise<OpenApiRpc> {
    return OpenApiRpcTarget.connect(input, this.props);
  }
}

export class OpenApiRpcTarget extends RpcTarget implements OpenApiRpc {
  static async connect(input: OpenApiConnectInput, deps: OpenApiDeps) {
    const spec = await fetchSpec(input, deps.egress);
    return new OpenApiRpcTarget({
      config: input,
      egress: deps.egress,
      operations: listOpenApiOperations(spec),
      spec,
    });
  }

  constructor(
    readonly props: {
      config: OpenApiConnectInput;
      egress: Fetcher;
      operations: OpenApiOperation[];
      spec: Record<string, unknown>;
    },
  ) {
    super();
    return withInvokeCapabilityFallback(this);
  }

  async describe(): Promise<CapabilityDescriptionMetadata> {
    const info = (this.props.spec.info ?? {}) as { title?: string; version?: string };
    const title = info.title ?? "OpenAPI API";
    return {
      instructions:
        `${title}${info.version ? ` v${info.version}` : ""}: ` +
        "call operations directly by operationId with one input object containing path params, " +
        "query params, and body fields. Call describe() for this capability's instructions and TypeScript declarations.",
      types: deriveOpenApiCapabilityTypes(this.props.spec),
    };
  }

  async invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    const operationId = path[0];
    if (!operationId) throw new Error("OpenAPI operation calls need an operationId path.");
    if (path.length > 1) {
      throw new Error(`OpenAPI operations are flat operationIds, got "${path.join(".")}".`);
    }
    const operation = this.props.operations.find(
      (candidate) => candidate.operationId === operationId,
    );
    if (!operation) {
      throw new Error(`Operation "${operationId}" is not in the OpenAPI spec.`);
    }
    return await executeOperation({
      egress: this.props.egress,
      input: args[0],
      operation,
      props: this.props.config,
      spec: this.props.spec,
    });
  }
}

export async function invokeOpenApiCapability(args: {
  config: OpenApiConnectInput;
  deps: OpenApiDeps;
  path: string[];
  rpcArgs?: unknown[];
}) {
  // Mounted OpenAPI capabilities are stored as plain config in the ITX stream.
  // Reconnecting here keeps the record durable and avoids adding another cache
  // or Durable Object just to hold a parsed spec for this reference app.
  const target = await OpenApiRpcTarget.connect(args.config, args.deps);
  return await replayPath({ args: args.rpcArgs ?? [], path: args.path, target });
}

async function fetchSpec(
  props: OpenApiConnectInput,
  egress: Fetcher,
): Promise<Record<string, unknown>> {
  const specHost = new URL(props.specUrl).host;
  const apiHost = props.baseUrl ? new URL(props.baseUrl).host : specHost;
  // Headers can contain getSecret({ path: "/secrets/..." }) placeholders.
  // They must enter the project egress pipe, because that is the only place
  // secret material is substituted. Do not read or rewrite them here.
  const response = await egress.fetch(
    new Request(props.specUrl, { headers: specHost === apiHost ? (props.headers ?? {}) : {} }),
  );
  if (!response.ok) {
    throw new Error(`Fetching the OpenAPI spec at ${props.specUrl} returned ${response.status}.`);
  }
  const spec = (await response.json()) as Record<string, unknown>;
  if (!spec || typeof spec !== "object" || typeof spec.openapi !== "string") {
    throw new Error(`Fetching the OpenAPI spec at ${props.specUrl} did not return OpenAPI JSON.`);
  }
  return spec;
}

async function executeOperation(args: {
  egress: Fetcher;
  input: unknown;
  operation: OpenApiOperation;
  props: OpenApiConnectInput;
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
      throw new Error(
        `Operation "${operation.operationId}" has no request body and got unknown input ` +
          `key${leftover.length > 1 ? "s" : ""} ${leftover.map((key) => JSON.stringify(key)).join(", ")}.`,
      );
    }
  }

  const url = new URL(resolvedPath.replace(/^\//, ""), requestBase(props, spec));
  for (const [name, value] of query) url.searchParams.set(name, value);

  let body: string | undefined;
  if (operation.requestBody && Object.keys(input).length > 0) {
    // One input object is split into path/query params first; leftovers are the
    // JSON body. Non-object request bodies use `{ body }` so the convention is
    // still representable as one TypeScript parameter.
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

  const response = await args.egress.fetch(
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

function requestBase(props: OpenApiConnectInput, spec: Record<string, unknown>): string {
  if (props.baseUrl) return ensureTrailingSlash(props.baseUrl);
  const servers = spec.servers as Array<{ url?: string }> | undefined;
  const serverUrl = servers?.[0]?.url;
  if (serverUrl) return ensureTrailingSlash(new URL(serverUrl, props.specUrl).toString());
  return new URL("/", props.specUrl).toString();
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
