import { RpcTarget } from "cloudflare:workers";
import type { ProjectCapabilityApi } from "~/domains/projects/durable-objects/project-durable-object.ts";

export class ProjectCapability extends RpcTarget {
  constructor(private readonly project: ProjectCapabilityApi) {
    super();
  }

  afterAppend(...args: Parameters<ProjectCapabilityApi["afterAppend"]>) {
    return this.project.afterAppend(...args);
  }

  callConfigWorkerFunction(...args: Parameters<ProjectCapabilityApi["callConfigWorkerFunction"]>) {
    return this.project.callConfigWorkerFunction(...args);
  }

  checkAccess(...args: Parameters<ProjectCapabilityApi["checkAccess"]>) {
    return this.project.checkAccess(...args);
  }

  createProject(...args: Parameters<ProjectCapabilityApi["createProject"]>) {
    return this.project.createProject(...args);
  }

  describe(...args: Parameters<ProjectCapabilityApi["describe"]>) {
    return this.project.describe(...args);
  }

  egressFetch(...args: Parameters<ProjectCapabilityApi["egressFetch"]>) {
    return this.project.egressFetch(...args);
  }

  fetch(...args: Parameters<ProjectCapabilityApi["fetch"]>) {
    return this.project.fetch(...args);
  }

  getCapability(...args: Parameters<ProjectCapabilityApi["getCapability"]>) {
    return this.project.getCapability(...args);
  }

  getConfigWorker(...args: Parameters<ProjectCapabilityApi["getConfigWorker"]>) {
    return this.project.getConfigWorker(...args);
  }

  getConnection(...args: Parameters<ProjectCapabilityApi["getConnection"]>) {
    return this.project.getConnection(...args);
  }

  getIterateContext(...args: Parameters<ProjectCapabilityApi["getIterateContext"]>) {
    return this.project.getIterateContext(...args);
  }

  getProjectLifecycleRunnerState(
    ...args: Parameters<ProjectCapabilityApi["getProjectLifecycleRunnerState"]>
  ) {
    return this.project.getProjectLifecycleRunnerState(...args);
  }

  getSummary(...args: Parameters<ProjectCapabilityApi["getSummary"]>) {
    return this.project.getSummary(...args);
  }

  ingressFetch(...args: Parameters<ProjectCapabilityApi["ingressFetch"]>) {
    return this.project.ingressFetch(...args);
  }

  ingressUrl(...args: Parameters<ProjectCapabilityApi["ingressUrl"]>) {
    return this.project.ingressUrl(...args);
  }

  provideCapability(...args: Parameters<ProjectCapabilityApi["provideCapability"]>) {
    return this.project.provideCapability(...args);
  }
}
