import { RpcTarget } from "cloudflare:workers";
import { ProjectReposCapability } from "./repos-capability.ts";
import { ProjectStreamsCapability } from "./streams-capability.ts";
import { ProjectWorkspaceCapability, ProjectWorkspacesCapability } from "./workspace-capability.ts";
import type { IterateContextProps } from "./iterate-context-capability.ts";
import type { AppContext } from "~/context.ts";
import type { ProjectCapability as ProjectDurableObjectCapability } from "~/domains/projects/durable-objects/project-durable-object.ts";

export class ProjectCapability extends RpcTarget {
  #connections?: ProjectConnectionsCapability;
  #repos?: ProjectReposCapability;
  #streams?: ProjectStreamsCapability;
  #workspace?: ProjectWorkspaceCapability;
  #workspaces?: ProjectWorkspacesCapability;
  #worker?: ProjectWorkerCapability;

  constructor(
    private readonly input: {
      context: AppContext;
      iterateContextProps?: IterateContextProps;
      project: () => Promise<ProjectDurableObjectCapability> | ProjectDurableObjectCapability;
      projectId: () => Promise<string> | string;
      projectIdOrSlug: string;
    },
  ) {
    super();
  }

  get connections(): ProjectConnectionsCapability {
    return (this.#connections ??= new ProjectConnectionsCapability(() => this.project()));
  }

  get repos(): ProjectReposCapability {
    return (this.#repos ??= new ProjectReposCapability({
      context: this.input.context,
      projectId: () => this.projectId(),
    }));
  }

  get streams(): ProjectStreamsCapability {
    return (this.#streams ??= new ProjectStreamsCapability({
      context: this.input.context,
      projectId: () => this.projectId(),
    }));
  }

  get workspace(): ProjectWorkspaceCapability {
    return (this.#workspace ??= new ProjectWorkspaceCapability({
      context: this.input.context,
      projectId: () => this.projectId(),
    }));
  }

  get workspaces(): ProjectWorkspacesCapability {
    return (this.#workspaces ??= new ProjectWorkspacesCapability({
      context: this.input.context,
      projectId: () => this.projectId(),
    }));
  }

  get worker(): ProjectWorkerCapability {
    return (this.#worker ??= new ProjectWorkerCapability({
      // Project worker calls are made from a particular IterateContext. If that
      // context has mounts, the iterate-config worker should see the same
      // ergonomic tree through env.ITERATE.context. This is what lets a caller
      // mount a parent-provided capability at ctx.slack and then call a config
      // tool that uses ctx.slack internally.
      //
      // The worker child does not get to preserve arbitrary authority. Before
      // these props reach the Project Durable Object, projectConfigWorkerProps()
      // below rewrites scopes to this one project and only carries mounts
      // forward.
      iterateContextProps: this.input.iterateContextProps,
      project: () => this.project(),
      projectId: () => this.projectId(),
    }));
  }

  afterAppend(...args: any[]) {
    return this.project().then((project) => (project.afterAppend as any)(...args));
  }

  callConfigWorkerFunction(...args: any[]) {
    return this.project().then((project) => (project.callConfigWorkerFunction as any)(...args));
  }

  checkAccess(...args: any[]) {
    return this.project().then((project) => ((project as any).checkAccess as any)(...args));
  }

  createProject(...args: any[]) {
    return this.project().then((project) => ((project as any).createProject as any)(...args));
  }

  describe(...args: any[]) {
    return this.project().then((project) => (project.describe as any)(...args));
  }

  egressFetch(...args: any[]) {
    return this.project().then((project) => (project.egressFetch as any)(...args));
  }

  fetch(...args: any[]) {
    return this.project().then((project) => (project.fetch as any)(...args));
  }

  getCapability(...args: any[]) {
    return this.project().then((project) => (project.getCapability as any)(...args));
  }

  getConfigWorker(...args: any[]) {
    return this.project().then((project) => (project.getConfigWorker as any)(...args));
  }

  getConnection(...args: any[]) {
    return this.project().then((project) => (project.getConnection as any)(...args));
  }

  getIterateContext(...args: any[]) {
    return this.project().then((project) => (project.getIterateContext as any)(...args));
  }

  getProjectLifecycleRunnerState(...args: any[]) {
    return this.project().then((project) =>
      (project.getProjectLifecycleRunnerState as any)(...args),
    );
  }

  getSummary(...args: any[]) {
    return this.project().then((project) => (project.getSummary as any)(...args));
  }

  ingressFetch(...args: any[]) {
    return this.project().then((project) => (project.ingressFetch as any)(...args));
  }

  ingressUrl(...args: any[]) {
    return this.project().then((project) => (project.ingressUrl as any)(...args));
  }

  provideCapability(...args: any[]) {
    return this.project().then((project) => (project.provideCapability as any)(...args));
  }

  private async project() {
    return await this.input.project();
  }

  private async projectId() {
    return await this.input.projectId();
  }
}

export class ProjectConnectionsCapability extends RpcTarget {
  constructor(private readonly getProject: () => Promise<ProjectDurableObjectCapability>) {
    super();
  }

  get(connectionKey: string) {
    return this.getProject().then((project) => project.getConnection(connectionKey));
  }
}

export class ProjectWorkerCapability extends RpcTarget {
  [toolName: string]: any;

  constructor(
    private readonly input: {
      iterateContextProps?: IterateContextProps;
      project: () => Promise<ProjectDurableObjectCapability>;
      projectId: () => Promise<string>;
    },
  ) {
    super();
    // This RpcTarget deliberately returns a Proxy from its constructor.
    //
    // Why: the project config worker is a dynamic worker entrypoint. Workerd
    // does not let dynamically-loaded worker entrypoints be transferred across
    // worker/RPC boundaries, so ctx.project.worker cannot expose that raw
    // entrypoint directly. Instead this parent-owned RpcTarget keeps the real
    // dynamic worker inside the Project Durable Object and forwards:
    //
    //   ctx.project.worker.someTool(arg)
    //
    // into:
    //
    //   project.callConfigWorkerFunction({ functionName: "someTool", args: [arg] })
    //
    // Known members, symbols, and `fetch` still resolve on this RpcTarget. Any
    // unknown string property becomes an async function that forwards by name.
    // Returning undefined for `then` prevents the Proxy from being mistaken for
    // a thenable during RPC/promise assimilation.
    //
    // References:
    // - Workers RPC docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/
    // - Cap'n Web stubs: https://github.com/cloudflare/capnweb
    // - workerd Proxy-wrapped RpcTarget support landed after
    //   https://github.com/cloudflare/workerd/issues/3184 documented the
    //   DataCloneError limitation for Proxy-wrapped RpcTarget instances.
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop === "then") return undefined;
        if (typeof prop === "symbol" || prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        return async (...args: unknown[]) => {
          const projectId = await target.input.projectId();
          const project = await target.input.project();
          return await project.callConfigWorkerFunction({
            args,
            functionName: prop,
            iterateContextProps: projectConfigWorkerProps({
              iterateContextProps: target.input.iterateContextProps,
              projectId,
            }),
          });
        };
      },
    }) as ProjectWorkerCapability;
  }

  async fetch(request: Request) {
    return await (await this.input.project()).fetch(request);
  }
}

function projectConfigWorkerProps(input: {
  iterateContextProps?: IterateContextProps;
  projectId: string;
}): IterateContextProps | undefined {
  // Preserve caller mounts so ctx.project.worker.someTool() and the tool's own
  // env.ITERATE.context expose the same shortcut tree. Do not preserve caller
  // scopes: the project config worker is project-owned code, so it receives a
  // project-scoped context even when an all-projects/root context invoked it.
  if (!input.iterateContextProps?.mounts?.length) return undefined;
  return {
    mounts: input.iterateContextProps.mounts,
    scopes: { projects: [input.projectId] },
  };
}
