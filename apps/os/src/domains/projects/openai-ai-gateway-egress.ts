import { z } from "zod";
import type { ProjectAiInterceptorInput } from "../../lib/model-interception.ts";
import { aiGatewayMetadata } from "../agents/ai-gateway-metadata.ts";
import type { Env } from "../../env.ts";
import type { AppConfig } from "../../config.ts";
import { sendAiRequest, prepareOpenAiRequest } from "../agents/workers-ai-transport.ts";
import type { StreamContext } from "./stream-context.ts";

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
export async function routeOpenAiViaGateway(input: {
  request: Request;
  config: AppConfig;
  ai: Env["AI"];
  projectId: string;
  streamContext: StreamContext;
  consultInterceptor: ((request: ProjectAiInterceptorInput) => Promise<unknown>) | undefined;
}): Promise<Response | null> {
  const { request, config, streamContext } = input;
  // Preserve existing egress eligibility and credential substitution. Explicit
  // project secrets are handled by the Secret DO before reaching this route.
  if (request.method !== "POST" && request.method !== "PUT") return null;
  if (!config.cloudflare.accountId || !input.ai?.gateway) return null;
  const endpoint = openAiGatewayBindingEndpoint(request.url);
  if (endpoint.replace(/\?.*$/, "").length === 0) return null;

  let body: Record<string, unknown>;
  try {
    body = z.record(z.string(), z.unknown()).parse(await request.clone().json());
  } catch {
    return null;
  }

  const parsedModel = z.string().min(1).safeParse(body.model);
  if (!parsedModel.success) return null;
  const model = parsedModel.data;
  const gateway = config.cloudflareAiGateway;
  const prepared = await prepareOpenAiRequest({
    model,
    transport: {
      kind: "byok",
      gatewayId: gateway.id,
      openaiApiKey: config.openAiApiKey.exposeSecret(),
    },
    metadata: aiGatewayMetadata({
      identity: { projectId: input.projectId, environment: config.environmentName },
      context: streamContext,
      includeEventOffset: config.cloudflareAiGateway.includeEventOffset,
    }),
    endpoint,
    body,
    headers: request.headers,
    cache:
      gateway.responseCacheTtlSeconds === undefined
        ? null
        : { ttlSeconds: gateway.responseCacheTtlSeconds },
  });
  return sendAiRequest(
    { ai: input.ai, source: { source: "egress" }, consultInterceptor: input.consultInterceptor },
    prepared,
  );
}
