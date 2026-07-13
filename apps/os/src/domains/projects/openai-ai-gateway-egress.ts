/**
 * Route sandbox OpenAI JSON API calls through Cloudflare AI Gateway via the
 * Workers AI binding (`env.AI.gateway(id).run`) — same door agent BYOK uses.
 *
 * Only JSON POST/PUT to `api.openai.com` are handled (chat/completions,
 * responses, …). Other methods fall through to normal project egress.
 *
 * The platform OpenAI key is injected in trusted Project DO code; sandboxes
 * plant a dummy/placeholder `OPENAI_API_KEY` and never need the real key.
 */

import type { AppConfig } from "../../config.ts";
import { cloudflareAiGatewayResponseCacheKey } from "../agents/workers-ai-transport.ts";

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

/** Pull binding-path inputs from typed AppConfig; null when routing is impossible. */
export function openAiAiGatewayRoutingFromConfig(config: AppConfig): {
  gatewayId: string;
  openaiApiKey: string;
  responseCacheTtlSeconds?: number;
} | null {
  // accountId is not required for the Workers AI binding path.
  if (config.cloudflare.accountId === undefined || config.cloudflare.accountId.length === 0) {
    // Still require a deployed-shaped config so local miniflare without CF account
    // does not accidentally try to call a missing gateway binding with real keys.
    // Preview/prd always set ARTIFACTS_ACCOUNT_ID → cloudflare.accountId.
    return null;
  }
  return {
    gatewayId: config.cloudflareAiGateway.id,
    openaiApiKey: config.openAiApiKey.exposeSecret(),
    ...(config.cloudflareAiGateway.responseCacheTtlSeconds !== undefined
      ? { responseCacheTtlSeconds: config.cloudflareAiGateway.responseCacheTtlSeconds }
      : {}),
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
