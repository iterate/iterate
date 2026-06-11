// Project ingress: ALL requests to a project's hosts land here, in a
// stateless WorkerEntrypoint. The worker is loaded directly from its repo
// source — per-commit R2 build memo, same loader key as `itx.worker` dials,
// so all sites share warm isolates. The Project DO plays no part in serving
// requests; it only answers the project's summary.

import { WorkerEntrypoint } from "cloudflare:workers";
import { parseConfig } from "~/config.ts";
import { ingressHostnameFromRequest, normalizeIngressHost } from "~/ingress/host-routing.ts";
import { parseProjectPlatformHosts } from "~/ingress/project-platform-host-routing.ts";
import {
  getProjectDurableObjectName,
  type ProjectDurableObject,
  type ProjectSummary,
} from "~/domains/projects/durable-objects/project-durable-object.ts";
import {
  loadProjectWorker,
  type WorkerLoaderBinding,
} from "~/domains/projects/project-worker-runtime.ts";
import type { SourceBuildEnv } from "~/itx/source-build.ts";

type ProjectIngressEntrypointEnv = SourceBuildEnv & {
  APP_CONFIG: string;
  DB: D1Database;
  LOADER: WorkerLoaderBinding;
  PROJECT: DurableObjectNamespace<ProjectDurableObject>;
};

type ProjectIngressEntrypointProps = {
  projectId: string;
};

export class ProjectIngressEntrypoint extends WorkerEntrypoint<
  ProjectIngressEntrypointEnv,
  ProjectIngressEntrypointProps
> {
  async fetch(request: Request) {
    const summary = await this.project().getSummary();
    try {
      const entrypoint = await loadProjectWorker({
        env: this.env,
        exports: this.ctx.exports,
        projectId: summary.id,
      });
      return await entrypoint.fetch(
        withAppSlug({
          appSlug: await this.appSlugFromHost({ request, summary }),
          request,
        }),
      );
    } catch (error) {
      console.error("Project worker fetch failed; serving fallback landing response.", error);
      return landingResponse({ request, summary });
    }
  }

  /**
   * Which app within the project this host addresses: the subdomain prefix on
   * a platform host (`app1.demo.iterate.app`, `app1__demo.iterate.app`) or on
   * the project's custom hostname (`app1.example.com` when example.com is the
   * custom hostname). Forwarded to the worker as `x-iterate-app-slug`.
   */
  private async appSlugFromHost(input: { request: Request; summary: ProjectSummary }) {
    const host = normalizeIngressHost(ingressHostnameFromRequest(input.request));
    const platformHosts = parseProjectPlatformHosts({
      bases: parseConfig(this.env).projectHostnameBases,
      host,
    });
    for (const platformHost of platformHosts) {
      if (
        platformHost.projectIdentifier === input.summary.slug ||
        platformHost.projectIdentifier === input.summary.id
      ) {
        return platformHost.appSlug;
      }
    }

    const row = await this.env.DB.prepare(`SELECT custom_hostname FROM projects WHERE id = ?`)
      .bind(input.summary.id)
      .first<{ custom_hostname: string | null }>();
    const customHostname = row?.custom_hostname?.trim().toLowerCase();
    if (!customHostname) return null;

    if (host === customHostname) return null;
    if (!host.endsWith(`.${customHostname}`)) return null;

    const prefix = host.slice(0, host.length - customHostname.length - 1);
    return prefix !== "" && !prefix.includes(".") ? prefix : null;
  }

  private project(): DurableObjectStub<ProjectDurableObject> {
    return this.env.PROJECT.getByName(getProjectDurableObjectName(this.ctx.props.projectId));
  }
}

function withAppSlug(input: { appSlug: string | null; request: Request }) {
  if (input.appSlug === null) return input.request;

  const headers = new Headers(input.request.headers);
  headers.set("x-iterate-app-slug", input.appSlug);
  return new Request(input.request, { headers });
}

function landingResponse(input: { request: Request; summary: ProjectSummary }) {
  const url = new URL(input.request.url);
  const hostname = input.request.headers.get("x-iterate-ingress-hostname") ?? url.hostname;
  return new Response(
    JSON.stringify({
      defaultHost: input.summary.defaultHost,
      hostname,
      projectId: input.summary.id,
      slug: input.summary.slug,
    }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-project-ingress-runtime": "static-fallback",
      },
    },
  );
}
