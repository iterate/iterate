import { z } from "zod";
import type { ProjectAiInterceptorInput } from "../../lib/model-interception.ts";
import {
  aiGatewayMetadata,
  type createAiCostIdentityReader,
} from "../agents/ai-cost-attribution.ts";
import type { Env } from "../../env.ts";
/** Company-funded JSON requests use AI Gateway. Customer credentials retain
 * their provider billing; an unsupported company transport must fail closed. */

import type { AppConfig } from "../../config.ts";
import { sendAiRequest } from "../agents/workers-ai-transport.ts";
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
  consultInterceptor: ((request: ProjectAiInterceptorInput) => Promise<unknown>) | undefined;
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
  if (!config.cloudflare.accountId)
    throw new Error("Company AI Gateway has no account configuration");
  const endpoint = openAiGatewayBindingEndpoint(request.url);
  if (endpoint.replace(/\?.*$/, "").length === 0) return unsupported();

  let body: Record<string, unknown>;
  try {
    body = z.record(z.string(), z.unknown()).parse(await request.clone().json());
  } catch {
    return unsupported();
  }

  const parsedModel = z.string().min(1).safeParse(body.model);
  if (!parsedModel.success) return unsupported();
  const model = parsedModel.data;
  return sendAiRequest({
    ai: input.ai,
    transport: {
      kind: "byok",
      gatewayId: config.cloudflareAiGateway.id,
      openaiApiKey: config.openAiApiKey.exposeSecret(),
      responseCacheTtlSeconds: config.cloudflareAiGateway.responseCacheTtlSeconds,
    },
    model: model.startsWith("intercepted/") ? model : `openai/${model}`,
    body,
    endpoint,
    headers: request.headers,
    containsFiles: false,
    options: {},
    source: { source: "egress" },
    consultInterceptor: input.consultInterceptor,
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
  });
}
