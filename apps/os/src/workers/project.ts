/**
 * Project worker: project Durable Objects plus the project-host lane.
 *
 * Requests to project hosts (`<slug>.iterate.app`, custom hostnames, itx
 * capability hosts) arrive here over the service binding from the ingress
 * worker (or the app worker in local dev), with the resolved ingress rule on
 * an internal header. This worker's stateless fetch is where project-host
 * itx Cap'n Web sessions terminate (Law 7 — never in a DO), and where the
 * rule's loopback callable is dispatched against ctx.exports.
 *
 * This worker has no routes of its own — it is reachable only via service
 * bindings from workers that just resolved the rule, which is what makes the
 * resolved-rule header trustworthy.
 */
import { withEvlog } from "@iterate-com/shared/evlog";
import { readResolvedIngressHeader, type ResolvedIngressHeader } from "./shared/router.ts";
import { parseConfig, type AppConfig } from "~/config.ts";
import {
  dispatchFetchCallable,
  ingressHostnameFromRequest,
  normalizeIngressHost,
} from "~/ingress/host-routing.ts";
import { lookupIngressRule } from "~/ingress/lookup.ts";
import { handleProjectHostItxFetch } from "~/itx/fetch.ts";

export { ProjectDurableObject } from "~/domains/projects/durable-objects/project-durable-object.ts";
export { ProjectIngressEntrypoint } from "~/domains/projects/entrypoints/project-ingress-entrypoint.ts";
export { ProjectMcpServerEntrypoint } from "~/domains/inbound-mcp-server/entrypoints/project-mcp-server-entrypoint.ts";
export { ItxCapabilityIngress } from "~/itx/http.ts";
export * from "./shared/loopback-exports.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const config = parseConfig(env);
    return withEvlog(
      { request, app: { name: "@iterate-com/os", slug: "os-project" }, config, executionCtx: ctx },
      async () => {
        const resolved =
          readResolvedIngressHeader(request) ?? (await deriveIngressMatch(request, env, config));
        if (!resolved) {
          return Response.json({ worker: "os-project" }, { status: 404 });
        }

        // After this, baseUrl is always set (same fallback as the app worker).
        const requestConfig: AppConfig = config.baseUrl
          ? config
          : { ...config, baseUrl: new URL(request.url).origin as AppConfig["baseUrl"] };

        // Project-host itx sessions terminate HERE in the stateless worker,
        // never in the Project DO (itx Law 7 — the hibernation-ready seam).
        if (resolved.rule.projectId) {
          const projectItxResponse = await handleProjectHostItxFetch({
            config: requestConfig,
            env,
            exports: ctx.exports,
            projectId: resolved.rule.projectId,
            request,
          });
          if (projectItxResponse) return projectItxResponse;
        }

        return await dispatchFetchCallable({
          callable: resolved.rule.callable,
          context: {
            env: env as unknown as Record<string, unknown>,
            exports: ctx.exports,
          },
          request,
        });
      },
    );
  },
};

/** Fallback when no resolved-rule header is present (direct invocation,
 * tests): re-derive against D1 exactly like the routing hop would. */
async function deriveIngressMatch(
  request: Request,
  env: Env,
  config: AppConfig,
): Promise<ResolvedIngressHeader | null> {
  const requestHost = normalizeIngressHost(ingressHostnameFromRequest(request));
  const appHostname = new URL(config.baseUrl ?? request.url).hostname;
  const rule = await lookupIngressRule({
    appHostname,
    db: env.DB,
    host: requestHost,
    projectHostnameBases: config.projectHostnameBases ?? [],
  });
  return rule ? { requestHost, rule } : null;
}
