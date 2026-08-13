/**
 * Route project-egress OpenAI JSON API calls through Cloudflare AI Gateway via
 * the Workers AI binding (`env.AI.gateway(id).run`) — same door agent BYOK uses.
 *
 * Scope: **all** project egress (sandbox MITM, project worker `egress.fetch`,
 * etc.), not a sandbox-only branch. JSON POST/PUT to `api.openai.com` only;
 * other methods fall through to normal project egress (GET /models with a
 * dummy key will still 401).
 *
 * The platform OpenAI key is always injected in trusted Project DO code (same
 * key agent BYOK uses). Callers should plant a dummy/placeholder
 * `OPENAI_API_KEY`; customer keys in Authorization are replaced. The key is
 * not available via `getSecret({ platform: "openAiApiKey" })` — only via this
 * rewrite path.
 *
 * Binding-only: no REST AI Gateway rewrite and no direct-OpenAI platform-key
 * ladder (those paths 401'd under Authenticated Gateway without a Run token).
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
  if (Number.isFinite(input.responseCacheTtlSeconds)) {
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
  projectId: string;
  requestHeaders: Headers;
}): Record<string, string> {
  const caller =
    input.requestHeaders.get("x-iterate-sandbox") ??
    input.requestHeaders.get("x-iterate-agent") ??
    undefined;
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.openaiApiKey}`,
    "content-type": "application/json",
    // Same collect-log posture as agent BYOK in workers-ai-transport.ts.
    "cf-aig-collect-log": "true",
    "cf-aig-collect-log-payload": "true",
    "cf-aig-metadata": JSON.stringify({
      projectId: input.projectId,
      source: "project-egress",
      ...(!!caller && { caller }),
    }),
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
  if (!config.cloudflare.accountId || config.cloudflare.accountId.length === 0) {
    return null;
  }
  return {
    gatewayId: config.cloudflareAiGateway.id,
    openaiApiKey: config.openAiApiKey.exposeSecret(),
    ...(Number.isFinite(config.cloudflareAiGateway.responseCacheTtlSeconds) && {
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
