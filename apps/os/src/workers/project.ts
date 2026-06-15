/**
 * Project worker: project Durable Objects plus the project-host lane.
 *
 * Requests to project hosts (`<slug>.iterate.app`, custom hostnames, itx
 * capability hosts) arrive here over the service binding from the ingress
 * worker (or the app worker in local dev), with the resolved project target on
 * an internal header. The worker then calls the local named entrypoint directly.
 *
 * This worker has no routes of its own — it is reachable only via service
 * bindings from workers that just resolved the rule, which is what makes the
 * resolved-rule header trustworthy.
 */
import { withEvlog } from "@iterate-com/shared/evlog";
import { decideIngressRoute, readResolvedIngressHeader } from "./shared/router.ts";
import { parseConfig, type AppConfig } from "~/config.ts";

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
          readResolvedIngressHeader(request) ?? (await deriveResolvedIngress(request, env, config));
        if (!resolved) {
          return Response.json({ worker: "os-project" }, { status: 404 });
        }

        if (resolved.target === "itx") {
          return await ctx.exports
            .ItxCapabilityIngress({
              props: { capability: resolved.capability, projectId: resolved.projectId },
            })
            .fetch(request);
        }

        return await ctx.exports
          .ProjectIngressEntrypoint({ props: { projectId: resolved.projectId } })
          .fetch(withAppSlug({ appSlug: resolved.appSlug ?? null, request }));
      },
    );
  },
};

/** Fallback when no resolved-rule header is present (direct invocation,
 * tests): re-derive against D1 exactly like the routing hop would. */
async function deriveResolvedIngress(request: Request, env: Env, config: AppConfig) {
  const decision = await decideIngressRoute({
    config,
    db: env.DB,
    headers: request.headers,
    method: request.method,
    url: request.url,
  });
  if (decision.lane !== "project" && decision.lane !== "itx") return null;
  return decision.resolved;
}

function withAppSlug(input: { appSlug: string | null; request: Request }) {
  if (input.appSlug === null || input.request.headers.has("x-iterate-app-slug")) {
    return input.request;
  }
  const headers = new Headers(input.request.headers);
  headers.set("x-iterate-app-slug", input.appSlug);
  return new Request(input.request, { headers });
}
