/**
 * Route project-egress traffic aimed at OpenAI's public API through Cloudflare
 * AI Gateway so sandbox coding agents (Codex, etc.) get the same BYOK path,
 * observability, and spend controls as platform agents — without teaching every
 * CLI about gateway URLs.
 *
 * OpenAI host → AI Gateway OpenAI provider-native base:
 *   https://api.openai.com/v1/<rest>
 *   → https://gateway.ai.cloudflare.com/v1/<accountId>/<gatewayId>/openai/<rest>
 *
 * Runs only in trusted Project DO egress (after interceptors / approval). The
 * platform OpenAI key is injected here deliberately: project egress does NOT
 * expose `getSecret({ platform: "openAiApiKey" })` (see platform-secrets.ts);
 * sandbox CLIs plant a placeholder or dummy key and this door rewrites + pays.
 */

import type { AppConfig } from "../../config.ts";

/** True when the request targets OpenAI's public API host (http or https). */
export function isOpenAiPublicApiRequest(request: Request): boolean {
  try {
    return new URL(request.url).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

/**
 * Build the AI Gateway OpenAI provider-native URL for one OpenAI API request.
 * Preserves query string; maps `/v1/<rest>` → `/v1/<account>/<gateway>/openai/<rest>`.
 */
export function openAiAiGatewayUrl(input: {
  accountId: string;
  gatewayId: string;
  openAiUrl: string;
}): string {
  const src = new URL(input.openAiUrl);
  if (src.hostname !== "api.openai.com") {
    throw new Error(`openAiAiGatewayUrl: expected api.openai.com, got ${src.hostname}`);
  }
  // `/v1/chat/completions` → `chat/completions`; bare `/v1` or `/v1/` → ""
  const rest = src.pathname.replace(/^\/v1\/?/, "");
  const path =
    rest.length === 0
      ? `/v1/${input.accountId}/${input.gatewayId}/openai`
      : `/v1/${input.accountId}/${input.gatewayId}/openai/${rest}`;
  return `https://gateway.ai.cloudflare.com${path}${src.search}`;
}

/** Metadata stamped on every rewritten request (AI Gateway allows ≤5 entries). */
type OpenAiAiGatewayMetadata = {
  projectId: string;
  source: "project-egress";
  /** Optional sandbox / agent path when known from headers; otherwise omitted. */
  caller?: string;
};

/**
 * Rewrite an OpenAI API Request onto AI Gateway and inject the platform key +
 * gateway headers. Does not fetch — caller runs fetch / fetchWithCredentialRedirects.
 */
export function rewriteOpenAiRequestToAiGateway(input: {
  request: Request;
  accountId: string;
  gatewayId: string;
  openaiApiKey: string;
  metadata: OpenAiAiGatewayMetadata;
  /** When the gateway requires Authenticated Gateway, pass a CF API token with AI Gateway Run. */
  cfAigAuthorization?: string;
  /** prd-style: never serve a cached whole-answer (matches workers-ai-transport). */
  skipCache?: boolean;
}): Request {
  const gatewayUrl = openAiAiGatewayUrl({
    accountId: input.accountId,
    gatewayId: input.gatewayId,
    openAiUrl: input.request.url,
  });

  const headers = new Headers(input.request.headers);
  // Drop hop-by-hop headers that confuse the gateway edge.
  headers.delete("host");
  headers.delete("connection");
  headers.delete("keep-alive");
  headers.delete("transfer-encoding");
  headers.delete("upgrade");
  headers.delete("proxy-connection");

  headers.set("Authorization", `Bearer ${input.openaiApiKey}`);
  headers.set("cf-aig-metadata", JSON.stringify(compactMetadata(input.metadata)));
  if (input.skipCache) {
    headers.set("cf-aig-skip-cache", "true");
  } else {
    headers.delete("cf-aig-skip-cache");
  }
  if (input.cfAigAuthorization !== undefined && input.cfAigAuthorization.length > 0) {
    headers.set("cf-aig-authorization", `Bearer ${input.cfAigAuthorization}`);
  }

  // duplex required when re-streaming a request body in some runtimes.
  const init: RequestInit & { duplex?: "half" } = {
    method: input.request.method,
    headers,
    redirect: "manual",
  };
  if (input.request.method !== "GET" && input.request.method !== "HEAD") {
    init.body = input.request.body;
    if (input.request.body !== null) {
      init.duplex = "half";
    }
  }
  return new Request(gatewayUrl, init);
}

/** Pull gateway routing inputs from typed AppConfig; null when rewrite is impossible. */
export function openAiAiGatewayRoutingFromConfig(config: AppConfig): {
  accountId: string;
  gatewayId: string;
  openaiApiKey: string;
  cfAigAuthorization?: string;
  skipCache: boolean;
} | null {
  const accountId = config.cloudflare.accountId;
  if (accountId === undefined || accountId.length === 0) return null;
  const gatewayId = config.cloudflareAiGateway.id;
  const openaiApiKey = config.openAiApiKey.exposeSecret();
  const cfToken = config.cloudflare.apiToken?.exposeSecret();
  return {
    accountId,
    gatewayId,
    openaiApiKey,
    ...(cfToken !== undefined && cfToken.length > 0 ? { cfAigAuthorization: cfToken } : {}),
    // Match agent BYOK: only preview/dev set a response-cache TTL; prd skips.
    skipCache: config.cloudflareAiGateway.responseCacheTtlSeconds === undefined,
  };
}

function compactMetadata(
  metadata: OpenAiAiGatewayMetadata,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {
    projectId: metadata.projectId,
    source: metadata.source,
  };
  if (metadata.caller !== undefined && metadata.caller.length > 0) {
    out.caller = metadata.caller;
  }
  return out;
}
