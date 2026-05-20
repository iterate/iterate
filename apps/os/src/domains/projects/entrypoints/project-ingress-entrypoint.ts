import { WorkerEntrypoint } from "cloudflare:workers";
import {
  PROJECT_EGRESS_INTERCEPT_ROUTE,
  getProjectDurableObjectName,
  type ProjectDurableObject,
} from "~/domains/projects/durable-objects/project-durable-object.ts";

type ProjectIngressEntrypointEnv = {
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
    const stub = this.env.PROJECT.getByName(getProjectDurableObjectName(this.ctx.props.projectId));
    if (new URL(request.url).pathname === PROJECT_EGRESS_INTERCEPT_ROUTE) {
      return await stub.fetch(request);
    }
    return await stub.ingressFetch(request);
  }
}
