import { WorkerEntrypoint } from "cloudflare:workers";
import {
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
    if (new URL(request.url).pathname === "/__iterate/intercept-project-egress") {
      return await stub.fetch(request);
    }
    return await stub.ingressFetch(request);
  }
}
