import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
  getProjectDurableObjectName,
  type ProjectDynamicWorkerFacetRequest,
  type ProjectDurableObject,
} from "~/domains/projects/durable-objects/project-durable-object.ts";

export type ProjectDynamicDurableObjectFacetSelector = {
  className: string;
  name: string;
};

type ProjectDynamicDurableObjectsBindingEnv = {
  PROJECT: DurableObjectNamespace<ProjectDurableObject>;
};

type ProjectDynamicDurableObjectsBindingProps = {
  commitOid: string;
  projectId: string;
};

export class ProjectDynamicDurableObjectsBinding extends WorkerEntrypoint<
  ProjectDynamicDurableObjectsBindingEnv,
  ProjectDynamicDurableObjectsBindingProps
> {
  get(input: ProjectDynamicDurableObjectFacetSelector): ProjectDynamicDurableObjectFacetHandle {
    return new ProjectDynamicDurableObjectFacetHandle({
      className: input.className,
      commitOid: this.ctx.props.commitOid,
      name: input.name,
      project: this.project(),
    });
  }

  getByName(
    input: ProjectDynamicDurableObjectFacetSelector,
  ): ProjectDynamicDurableObjectFacetHandle {
    return this.get(input);
  }

  private project() {
    return this.env.PROJECT.getByName(getProjectDurableObjectName(this.ctx.props.projectId));
  }
}

class ProjectDynamicDurableObjectFacetHandle extends RpcTarget {
  readonly #className: string;
  readonly #commitOid: string;
  readonly #name: string;
  readonly #project: DurableObjectStub<ProjectDurableObject>;

  constructor(input: {
    className: string;
    commitOid: string;
    name: string;
    project: DurableObjectStub<ProjectDurableObject>;
  }) {
    super();
    this.#className = input.className;
    this.#commitOid = input.commitOid;
    this.#name = input.name;
    this.#project = input.project;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.#project.fetchDynamicWorkerDurableObjectFacet({
        className: this.#className,
        commitOid: this.#commitOid,
        name: this.#name,
        request: await projectDynamicWorkerFacetRequest(request),
      });
    } catch (error) {
      throw new Error(`Project Dynamic Durable Object binding failed: ${errorMessage(error)}`);
    }
  }
}

async function projectDynamicWorkerFacetRequest(
  request: Request,
): Promise<ProjectDynamicWorkerFacetRequest> {
  return {
    body:
      request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer(),
    headers: Array.from(request.headers.entries()),
    method: request.method,
    url: request.url,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
