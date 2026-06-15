// Project ingress: ALL requests to a project's hosts land here, in a
// stateless WorkerEntrypoint. The worker is loaded directly from its repo
// source — per-commit R2 build memo, same loader key as `itx.worker` dials,
// so all sites share warm isolates. The Project DO plays no part in serving
// requests.

import { WorkerEntrypoint } from "cloudflare:workers";
import {
  loadProjectWorker,
  type WorkerLoaderBinding,
} from "~/domains/projects/project-worker-runtime.ts";
import type { SourceBuildEnv } from "~/itx/source-build.ts";

type ProjectIngressEntrypointEnv = SourceBuildEnv & {
  LOADER: WorkerLoaderBinding;
};

type ProjectIngressEntrypointProps = {
  projectId: string;
};

export class ProjectIngressEntrypoint extends WorkerEntrypoint<
  ProjectIngressEntrypointEnv,
  ProjectIngressEntrypointProps
> {
  async fetch(request: Request) {
    try {
      const entrypoint = await loadProjectWorker({
        env: this.env,
        exports: this.ctx.exports,
        projectId: this.ctx.props.projectId,
      });
      return await entrypoint.fetch(request);
    } catch (error) {
      console.error("Project worker fetch failed; serving fallback landing response.", error);
      return landingResponse({ projectId: this.ctx.props.projectId, request });
    }
  }
}

function landingResponse(input: { projectId: string; request: Request }) {
  const url = new URL(input.request.url);
  const hostname = input.request.headers.get("x-iterate-ingress-hostname") ?? url.hostname;
  return new Response(
    JSON.stringify({
      hostname,
      projectId: input.projectId,
    }),
    {
      status: 502,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-project-ingress-runtime": "static-fallback",
      },
    },
  );
}
