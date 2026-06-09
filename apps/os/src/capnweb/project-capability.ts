import { RpcTarget } from "cloudflare:workers";
import { ProjectReposCapability } from "./repos-capability.ts";
import { ProjectStreamsCapability } from "./streams-capability.ts";
import { ProjectWorkspaceCapability } from "./workspace-capability.ts";
import type { IterateContextProps } from "./iterate-context-capability.ts";
import type { RequestContext } from "~/request-context.ts";
import type { ProjectCapabilityApi } from "~/domains/projects/durable-objects/project-durable-object.ts";

export class ProjectCapability extends RpcTarget {
  #connections?: ProjectConnectionsCapability;
  #repos?: ProjectReposCapability;
  #streams?: ProjectStreamsCapability;
  #workspace?: ProjectWorkspaceCapability;
  #worker?: ProjectWorkerCapability;

  constructor(
    private readonly input: {
      context: RequestContext;
      iterateContextProps?: IterateContextProps;
      project: ProjectCapabilityApi;
      projectId: string;
    },
  ) {
    super();
  }

  get connections(): ProjectConnectionsCapability {
    return (this.#connections ??= new ProjectConnectionsCapability(this.input.project));
  }

  get repos(): ProjectReposCapability {
    return (this.#repos ??= new ProjectReposCapability({
      context: this.input.context,
      projectId: this.input.projectId,
    }));
  }

  get streams(): ProjectStreamsCapability {
    return (this.#streams ??= new ProjectStreamsCapability({
      context: this.input.context,
      projectId: this.input.projectId,
    }));
  }

  get workspace(): ProjectWorkspaceCapability {
    return (this.#workspace ??= new ProjectWorkspaceCapability({
      context: this.input.context,
      projectId: this.input.projectId,
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
      project: this.input.project,
      projectId: this.input.projectId,
    }));
  }

  afterAppend(...args: Parameters<ProjectCapabilityApi["afterAppend"]>) {
    return this.input.project.afterAppend(...args);
  }

  callConfigWorkerFunction(...args: Parameters<ProjectCapabilityApi["callConfigWorkerFunction"]>) {
    return this.input.project.callConfigWorkerFunction(...args);
  }

  createProject(...args: Parameters<ProjectCapabilityApi["createProject"]>) {
    return this.input.project.createProject(...args);
  }

  describe(...args: Parameters<ProjectCapabilityApi["describe"]>) {
    return this.input.project.describe(...args);
  }

  egressFetch(...args: Parameters<ProjectCapabilityApi["egressFetch"]>) {
    return this.input.project.egressFetch(...args);
  }

  fetch(...args: Parameters<ProjectCapabilityApi["fetch"]>) {
    return this.input.project.fetch(...args);
  }

  getCapability(...args: Parameters<ProjectCapabilityApi["getCapability"]>) {
    return this.input.project.getCapability(...args);
  }

  getConfigWorker(...args: Parameters<ProjectCapabilityApi["getConfigWorker"]>) {
    return this.input.project.getConfigWorker(...args);
  }

  getConnection(...args: Parameters<ProjectCapabilityApi["getConnection"]>) {
    return this.input.project.getConnection(...args);
  }

  getIterateContext(...args: Parameters<ProjectCapabilityApi["getIterateContext"]>) {
    return this.input.project.getIterateContext(...args);
  }

  getProjectLifecycleRunnerState(
    ...args: Parameters<ProjectCapabilityApi["getProjectLifecycleRunnerState"]>
  ) {
    return this.input.project.getProjectLifecycleRunnerState(...args);
  }

  getSummary(...args: Parameters<ProjectCapabilityApi["getSummary"]>) {
    return this.input.project.getSummary(...args);
  }

  ingressFetch(...args: Parameters<ProjectCapabilityApi["ingressFetch"]>) {
    return this.input.project.ingressFetch(...args);
  }

  ingressUrl(...args: Parameters<ProjectCapabilityApi["ingressUrl"]>) {
    return this.input.project.ingressUrl(...args);
  }

  provideCapability(...args: Parameters<ProjectCapabilityApi["provideCapability"]>) {
    return this.input.project.provideCapability(...args);
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
  constructor(
    private readonly input: {
      iterateContextProps?: IterateContextProps;
      project: ProjectCapabilityApi;
      projectId: string;
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
          return await target.input.project.callConfigWorkerFunction({
            args,
            functionName: prop,
            iterateContextProps: projectConfigWorkerProps({
              iterateContextProps: target.input.iterateContextProps,
              projectId: target.input.projectId,
            }),
          });
        };
      },
    }) as ProjectWorkerCapability;
  }

  async fetch(request: Request) {
    return await this.input.project.fetch(request);
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
