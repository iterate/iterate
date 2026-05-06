import { DurableObject } from "cloudflare:workers";
import { parseAppConfig } from "@iterate-com/shared/apps/config";
import { ProjectId } from "@iterate-com/shared/streams/types";
import { AppConfig } from "~/app.ts";
import { getProjectUrl, workerReachableLocalUrl } from "~/lib/events-urls.ts";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";
import { createOpenApiToolProvider } from "~/lib/openapi-tool-provider.ts";

const ITERATE_EVENTS_OPERATION_IDS = [
  "appendStreamEvents",
  "getStreamState",
  "__internal.health",
  "streamEvents",
  "listChildren",
] as const;

/**
 * Callable-backed DO exposing Iterate Events OpenAPI operations as codemode tools,
 * wired from presets via
 * {@link import("@iterate-com/shared/callable/types.ts").Callable} RPC refs.
 */

interface GetTypesPayload {
  namespace?: string;
}

interface GetTypesResponse {
  types: string;
}

interface CallToolPayload {
  name: string;
  args: unknown[];
}

export class OpenApiToolClient extends DurableObject<CloudflareEnv> {
  #providerPromise: Promise<Awaited<ReturnType<typeof createOpenApiToolProvider>>>;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    const config = parseAppConfig(AppConfig, env.APP_CONFIG);
    const eventsOrigin = getProjectUrl({
      currentUrl: config.eventsBaseUrl,
      projectId: ProjectId.parse(config.eventsProjectSlug),
    })
      .toString()
      .replace(/\/+$/, "");
    const eventsFetchOrigin = workerReachableLocalUrl(eventsOrigin).replace(/\/+$/, "");
    this.#providerPromise = state.blockConcurrencyWhile(() =>
      createOpenApiToolProvider({
        name: "iterate_events",
        spec: `${eventsFetchOrigin}/api/openapi.json`,
        baseUrl: `${eventsFetchOrigin}/api/`,
        operationIds: ITERATE_EVENTS_OPERATION_IDS,
        fetch: globalThis.fetch.bind(globalThis),
      }),
    );
  }

  async getTypes(payload: GetTypesPayload | null): Promise<GetTypesResponse> {
    const provider = await this.#providerPromise;
    const rawTypes = provider.types;
    if (typeof rawTypes !== "string") {
      throw new Error("OpenAPI tool provider missing generated types string");
    }
    const namespace = payload?.namespace ?? "iterate_events";
    const types = rawTypes.replace(/^declare const \w+:/m, `declare const ${namespace}:`);
    return { types };
  }

  async callTool(payload: CallToolPayload): Promise<unknown> {
    const provider = await this.#providerPromise;
    const tools = provider.tools;
    if (tools == null) {
      throw new Error("OpenAPI tool provider missing tools map");
    }
    const tool = tools[payload.name];
    if (!tool) {
      throw new Error(`OpenAPI tool "${payload.name}" not found on Iterate Events spec`);
    }
    const args = extractSingleObjectArgs(payload.args);
    // `createOpenApiToolProvider` registers single-argument executors; codemode's
    // exported ToolProvider typing is wider (optional maps / alternate execute arity).
    const run = tool.execute as (input: unknown) => Promise<unknown>;
    return await run(args);
  }
}

function extractSingleObjectArgs(args: unknown[]): Record<string, unknown> {
  if (args.length === 0) return {};
  if (args.length > 1) {
    throw new Error(`OpenAPI tool call expects a single arguments object, got ${args.length} args`);
  }
  const first = args[0];
  if (first == null) return {};
  if (typeof first !== "object" || Array.isArray(first)) {
    throw new Error("OpenAPI tool call argument must be a plain object");
  }
  return first as Record<string, unknown>;
}
