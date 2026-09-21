// platform-origin.ts — THE PLATFORM ORIGIN at runtime: the OAuth issuer identifier, what `/api`,
// `/mcp` and the issuer's pages hang under. `urls.os` when the deployment names one (app-config.ts);
// else the origin of the first PLATFORM request this isolate served — remembered by the edge
// (worker.ts) once it has ruled out a project host — because the helpers that hold an env but no
// request (the OAuth provider's options, a session's grants, consent) still need it. A deployment
// with one hostname (workers.dev, the paths ingress) is exactly one origin, so first-request-wins is
// the truth there; a deployment with more than one hostname (subdomains, a separate MCP origin)
// sets `urls.os`.
import { appConfigOf, type AppConfigEnv } from "./app-config.ts";

/** The header the edge (and a session's terminal fetch) stamps a fetch-lane Request with — the
 *  platform origin the caller reached the platform on — read and stripped by the context DO's fetch
 *  lane into the call's caller (a DO isolate cannot know it). Inbound `x-itx-*` headers never
 *  survive the edge, so an outsider's is gone before this is set. */
export const ITX_PLATFORM_ORIGIN_HEADER = "x-itx-platform-origin";

const rememberedByEnv = new WeakMap<object, string>();

/** The edge's word: `origin` served a platform request (not a project host, not the MCP origin).
 *  A no-op once `urls.os` is set or an origin is remembered. */
export function rememberPlatformOrigin(env: AppConfigEnv, origin: string): void {
  if (!appConfigOf(env).urls.os && !rememberedByEnv.has(env)) rememberedByEnv.set(env, origin);
}

/** The platform origin: `urls.os`, else the remembered one, else `candidate` (the edge's request in
 *  hand, before it has ruled out a project host). None of the three ⇒ an isolate with no request
 *  behind it yet (a DO's, a scheduled run's) on a deployment that never named its origin — the one
 *  thing this cannot answer, said plainly. */
export function platformOriginOf(env: AppConfigEnv, candidate?: string): string {
  const configured = appConfigOf(env).urls.os;
  if (configured) return configured;
  const remembered = rememberedByEnv.get(env);
  if (remembered) return remembered;
  if (candidate) return candidate;
  throw new Error(
    "APP_CONFIG urls.os is not set and this isolate has served no platform request yet — set urls.os (a deployment with more than one hostname must)",
  );
}
