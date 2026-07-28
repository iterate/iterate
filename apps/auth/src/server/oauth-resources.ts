import { expandOAuthResourceAudienceVariants } from "@iterate-com/shared/oauth-resource";
import { deployedPreviewEnvs, envs, semaphoreEnvs, streamsExampleEnvs } from "../../../../envs.ts";

export function getOsResourceBases() {
  return [
    envs.prd.baseUrl,
    "http://localhost:5173",
    // Fully-local dev runs on arbitrary ports (http://localhost:<port>), so
    // the RFC 8707 resource/audience is the stable portless loopback origin —
    // OS sets APP_CONFIG_ITERATE_AUTH__RESOURCE to match.
    "http://localhost",
    "http://127.0.0.1",
    ...deployedPreviewEnvs.map((env) => env.baseUrl),
  ];
}

/**
 * Semaphore is a relying party like OS (browser sign-in + bearer access
 * tokens against its own origin as the RFC 8707 resource). Local dev is
 * covered by the portless loopback origins in getOsResourceBases.
 */
export function getSemaphoreResourceBases() {
  return Object.values(semaphoreEnvs).map((env) => env.baseUrl);
}

/**
 * The streams playground is a relying party like OS and semaphore (browser
 * sign-in + bearer access tokens against its own origin as the RFC 8707
 * resource). These are the custom domains from envs.ts streamsExampleEnvs —
 * the app derives its resource from the request origin, so the old
 * workers.dev origins stopped matching the moment the custom domains went
 * live (the token exchange then 400s with "requested resource invalid").
 * Local dev is auth-less by design and needs no entry.
 */
export function getStreamsExampleResourceBases() {
  return Object.values(streamsExampleEnvs).map((env) => env.baseUrl);
}

export function getOsMcpResourceBases() {
  return expandOAuthResourceAudienceVariants([
    ...Object.values(envs).map((env) => env.mcpBaseUrl),
    "http://localhost:7301/api/__mcp",
  ]);
}
