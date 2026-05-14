import { WorkerEntrypoint } from "cloudflare:workers";
import {
  getProjectDurableObjectName,
  type ProjectDurableObject,
  type ProjectSummary,
} from "~/domains/projects/durable-objects/project-durable-object.ts";

type ProjectCapabilityEnv = {
  PROJECT: DurableObjectNamespace<ProjectDurableObject>;
};

export type ProjectCapabilityProps = {
  projectId: string;
};

export class ProjectCapability extends WorkerEntrypoint<
  ProjectCapabilityEnv,
  ProjectCapabilityProps
> {
  agents() {
    return this.ctx.exports.AgentCapability({ props: this.projectProps });
  }

  ai() {
    return this.ctx.exports.AiCapability({ props: this.projectProps });
  }

  fetchCapability() {
    return this.ctx.exports.FetchCapability({ props: this.projectProps });
  }

  gmail() {
    return this.ctx.exports.GmailCapability({ props: this.projectProps });
  }

  ingress() {
    return this.ctx.exports.ProjectIngressEntrypoint({ props: this.projectProps });
  }

  mcpServer() {
    return this.ctx.exports.ProjectMcpServerEntrypoint({ props: this.projectProps });
  }

  orpc() {
    return this.ctx.exports.OrpcCapability({ props: this.projectProps });
  }

  repos() {
    return this.ctx.exports.ReposCapability({ props: this.projectProps });
  }

  secrets() {
    return this.ctx.exports.SecretsCapability({ props: this.projectProps });
  }

  slack() {
    return this.ctx.exports.SlackCapability({ props: this.projectProps });
  }

  streams() {
    return this.ctx.exports.StreamsCapability({
      props: { namespace: this.ctx.props.projectId },
    });
  }

  async getSummary(): Promise<ProjectSummary> {
    return await this.project().getSummary();
  }

  async ingressFetch(request: Request): Promise<Response> {
    return await this.project().ingressFetch(request);
  }

  async egressFetch(request: Request): Promise<Response> {
    return await this.project().egressFetch(request);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.project().egressFetch(request);
  }

  private get projectProps() {
    return { projectId: this.ctx.props.projectId };
  }

  private project(): DurableObjectStub<ProjectDurableObject> {
    return this.env.PROJECT.getByName(getProjectDurableObjectName(this.ctx.props.projectId));
  }
}
