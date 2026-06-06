import { RpcTarget } from "cloudflare:workers";
import { ProjectReposCapability } from "./repos-capability.ts";
import { ProjectStreamsCapability } from "./streams-capability.ts";
import { ProjectWorkspaceCapability } from "./workspace-capability.ts";
import type { AppContext } from "~/context.ts";
import type { ProjectCapabilityApi } from "~/domains/projects/durable-objects/project-durable-object.ts";

export type ProjectDurableObjectContextClient = {
  getCapability(props?: { scopes?: unknown }): ProjectCapabilityApi;
};

export class ProjectContextCapability extends RpcTarget {
  readonly #context: AppContext;
  readonly #project: ProjectDurableObjectContextClient;
  readonly #projectId: string;
  #connections?: ProjectConnectionsCapability;
  #projectCapability?: ProjectCapabilityApi;
  #repos?: ProjectReposCapability;
  #streams?: ProjectStreamsCapability;
  #workspace?: ProjectWorkspaceCapability;
  #worker?: ProjectWorkerCapability;

  constructor(input: {
    context: AppContext;
    project: ProjectDurableObjectContextClient;
    projectId: string;
  }) {
    super();
    this.#context = input.context;
    this.#project = input.project;
    this.#projectId = input.projectId;
  }

  get repos(): ProjectReposCapability {
    return (this.#repos ??= new ProjectReposCapability({
      context: this.#context,
      projectId: this.#projectId,
    }));
  }

  get streams(): ProjectStreamsCapability {
    return (this.#streams ??= new ProjectStreamsCapability({
      context: this.#context,
      projectId: this.#projectId,
    }));
  }

  get workspace(): ProjectWorkspaceCapability {
    return (this.#workspace ??= new ProjectWorkspaceCapability({
      context: this.#context,
      projectId: this.#projectId,
    }));
  }

  get worker(): ProjectWorkerCapability {
    return (this.#worker ??= new ProjectWorkerCapability(this.projectCapability()));
  }

  get connections(): ProjectConnectionsCapability {
    return (this.#connections ??= new ProjectConnectionsCapability(this.projectCapability()));
  }

  async describe() {
    return await this.projectCapability().describe();
  }

  async fetch(request: Request) {
    return await this.projectCapability().fetch(request);
  }

  async getSummary() {
    return await this.projectCapability().getSummary();
  }

  async ingressFetch(request: Request) {
    return await this.projectCapability().ingressFetch(request);
  }

  async egressFetch(request: Request) {
    return await this.projectCapability().egressFetch(request);
  }

  async ingressUrl() {
    return await this.projectCapability().ingressUrl();
  }

  async provideCapability(input: { connectionKey: string; rpcTarget: any }) {
    // This is intentionally named after the capability model rather than the
    // current storage detail. It registers a caller-owned RPC target under
    // ctx.project.connections today; the same idea may eventually become the
    // general project API for publishing short-lived contextual capabilities.
    return await this.projectCapability().provideCapability(input);
  }

  private projectCapability() {
    return (this.#projectCapability ??= this.#project.getCapability({
      scopes: { projects: [this.#projectId] },
    }));
  }
}

export class ProjectConnectionsCapability extends RpcTarget {
  constructor(private readonly project: ProjectCapabilityApi) {
    super();
  }

  get(connectionKey: string) {
    return this.project.getConnection(connectionKey);
  }
}

export class ProjectWorkerCapability extends RpcTarget {
  constructor(private readonly project: ProjectCapabilityApi) {
    super();
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop === "then") return undefined;
        if (typeof prop === "symbol" || prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        return async (...args: unknown[]) => {
          return await target.project.callConfigWorkerFunction({
            args,
            functionName: prop,
          });
        };
      },
    }) as ProjectWorkerCapability;
  }

  async fetch(request: Request) {
    return await this.project.fetch(request);
  }
}
