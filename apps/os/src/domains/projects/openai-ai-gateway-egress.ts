import {
  aiGatewayMetadata,
  type AiGatewayMetadata,
  type createAiCostIdentityReader,
} from "../agents/ai-cost-attribution.ts";
import type { Env } from "../../env.ts";
/** Company-funded JSON requests use AI Gateway. Customer credentials retain
 * their provider billing; an unsupported company transport must fail closed. */

import type { AppConfig } from "../../config.ts";
import {
  cloudflareAiGatewayResponseCacheKey,
  withOpenAiStreamUsage,
} from "../agents/workers-ai-transport.ts";
import type { StreamContext } from "./stream-context.ts";

/** The host compares actual credentials, never a caller's billing-owner header.
 * The literal iterate-platform opts into the company credential without copying it.
 * Recognize copies in WebSocket subprotocols/URLs as well as Authorization. */
export function openAiCredentialOwner(
  request: Request,
  companyKey: string,
): "iterate" | "customer" {
  if (
    companyKey.length > 0 &&
    (request.url.includes(companyKey) ||
      [...request.headers.values()].some((value) => value.includes(companyKey)))
  )
    return "iterate";
  const authorization = request.headers.get("authorization");
  if (!authorization && !request.headers.has("sec-websocket-protocol")) return "iterate";
  return authorization === "Bearer iterate-platform" ? "iterate" : "customer";
}

/** True when the request targets OpenAI's public API host (http or https). */
export function isOpenAiPublicApiRequest(request: Request): boolean {
  try {
    return new URL(request.url).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

/**
 * Apply gateway cache headers to match agent BYOK (`workers-ai-transport.ts`):
 * - with TTL: `cf-aig-cache-ttl` + `cf-aig-cache-key` (body-derived)
 * - without: `cf-aig-skip-cache: true` so dashboard defaults never serve cache
 */
export async function applyOpenAiAiGatewayCacheHeaders(input: {
  headers: Headers | Record<string, string>;
  body: unknown;
  responseCacheTtlSeconds?: number;
}): Promise<void> {
  const set = (name: string, value: string) => {
    if (input.headers instanceof Headers) input.headers.set(name, value);
    else input.headers[name] = value;
  };
  const del = (name: string) => {
    if (input.headers instanceof Headers) input.headers.delete(name);
    else delete input.headers[name];
  };
  if (input.responseCacheTtlSeconds !== undefined) {
    set("cf-aig-cache-ttl", String(input.responseCacheTtlSeconds));
    set("cf-aig-cache-key", await cloudflareAiGatewayResponseCacheKey(input.body));
    del("cf-aig-skip-cache");
  } else {
    set("cf-aig-skip-cache", "true");
    del("cf-aig-cache-ttl");
    del("cf-aig-cache-key");
  }
}

/**
 * Headers for `AI.gateway().run` on the OpenAI provider path.
 * Injects the platform key, BYOK-parity collect-log flags, project metadata,
 * and allowlisted caller headers (OpenAI-* / Accept) for Codex and SDKs.
 */
export function openAiAiGatewayBindingHeaders(input: {
  openaiApiKey: string;
  metadata: AiGatewayMetadata;
  requestHeaders: Headers;
}): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.openaiApiKey}`,
    "content-type": "application/json",
    // Same collect-log posture as agent BYOK in workers-ai-transport.ts.
    "cf-aig-collect-log": "true",
    "cf-aig-collect-log-payload": "true",
    "cf-aig-metadata": JSON.stringify(input.metadata),
  };
  for (const [name, value] of input.requestHeaders.entries()) {
    const lower = name.toLowerCase();
    if (lower === "authorization" || lower === "content-type" || lower === "host") continue;
    if (lower.startsWith("openai-") || lower === "accept") {
      headers[lower] = value;
    }
  }
  return headers;
}

/** Pull binding-path inputs from typed AppConfig; null when routing is impossible. */
export function openAiAiGatewayRoutingFromConfig(config: AppConfig): {
  gatewayId: string;
  openaiApiKey: string;
  responseCacheTtlSeconds?: number;
} | null {
  // The Workers AI binding does not need accountId in the URL, but we still
  // require a deployed-shaped config (ARTIFACTS_ACCOUNT_ID → cloudflare.accountId
  // on preview/prd) so local miniflare without CF account does not call a
  // missing/half-wired gateway binding with the real platform key.
  if (config.cloudflare.accountId === undefined || config.cloudflare.accountId.length === 0) {
    return null;
  }
  return {
    gatewayId: config.cloudflareAiGateway.id,
    openaiApiKey: config.openAiApiKey.exposeSecret(),
    ...(config.cloudflareAiGateway.responseCacheTtlSeconds !== undefined && {
      responseCacheTtlSeconds: config.cloudflareAiGateway.responseCacheTtlSeconds,
    }),
  };
}

/**
 * Endpoint string for `AI.gateway().run`: path after `/v1/` plus any query.
 */
export function openAiGatewayBindingEndpoint(openAiUrl: string): string {
  const url = new URL(openAiUrl);
  const rest = url.pathname.replace(/^\/v1\/?/, "");
  return `${rest}${url.search}`;
}

/** Route in the calling fetch context: returning a response through an extra
 * cross-DO RPC hop can disconnect its body after headers have arrived. */
export async function routeCompanyOpenAi(input: {
  request: Request;
  config: AppConfig;
  ai: Env["AI"];
  readIdentity: ReturnType<typeof createAiCostIdentityReader>;
  streamContext: StreamContext;
}): Promise<Response | null> {
  const { request, config, streamContext } = input;
  if (openAiCredentialOwner(request, config.openAiApiKey.exposeSecret()) === "customer")
    return null;
  const unsupported = () =>
    Response.json(
      {
        error: {
          code: "company_ai_transport_unsupported",
          message:
            "Company-funded OpenAI calls require the configured JSON AI Gateway transport. This transport is unsupported; no direct provider request was sent.",
        },
      },
      { status: 400 },
    );
  if (
    (request.method !== "POST" && request.method !== "PUT") ||
    request.headers.get("upgrade")?.toLowerCase() === "websocket"
  )
    return unsupported();
  const routing = openAiAiGatewayRoutingFromConfig(config);
  if (routing === null) throw new Error("Company AI Gateway has no account configuration");

  const gateway = input.ai?.gateway?.(routing.gatewayId);
  if (gateway === undefined) throw new Error("Company AI Gateway binding is unavailable");

  const endpoint = openAiGatewayBindingEndpoint(request.url);
  if (endpoint.replace(/\?.*$/, "").length === 0) return unsupported();

  let body: unknown;
  try {
    body = await request.clone().json();
    if (endpoint.split("?")[0] === "chat/completions") body = withOpenAiStreamUsage(body);
  } catch {
    return unsupported();
  }

  const headers = openAiAiGatewayBindingHeaders({
    openaiApiKey: routing.openaiApiKey,
    metadata: aiGatewayMetadata(
      {
        ...(await input.readIdentity()),
        stream:
          streamContext.kind === "script-execution"
            ? {
                path: streamContext.streamPath,
                eventOffset: streamContext.scriptRunRequestedEventOffset,
              }
            : streamContext.kind === "scope"
              ? { path: streamContext.scopePath }
              : null,
      },
      config.cloudflareAiGateway.includeEventOffset,
    ),
    requestHeaders: request.headers,
  });
  await applyOpenAiAiGatewayCacheHeaders({
    headers,
    body,
    responseCacheTtlSeconds: routing.responseCacheTtlSeconds,
  });
  return gateway.run({
    provider: "openai",
    endpoint,
    headers,
    query: body,
  });
}
