import {
  SANDBOX_INSTANCE_TYPE_BINDINGS,
  SANDBOX_INSTANCE_TYPES,
} from "../src/domains/sandboxes/instance-types.ts";

export const WORKER_BUILDER_CONTAINER_CLASS_NAME = "WorkerBuilderDurableObject";
export const WORKER_BUILD_COORDINATOR_CLASS_NAME = "WorkerBuildCoordinatorDurableObject";

/** The builder pool lives on a dedicated, route-less Worker. Existing
 * environments reuse the retired esbuild builder script at this name, so a
 * new container namespace can be bootstrapped without deleting any Worker. */
export function workerBuilderWorkerName(osWorkerName: string) {
  return `${osWorkerName}-builder`;
}

/** Container-bearing Durable Object classes owned by the main OS worker.
 *
 * Deploy bootstrap and erase-data must consume this same list: omitting a
 * live class from erase-data retires its container application and tombstones
 * its namespace, while the next exports-mode deploy cannot recreate that
 * namespace container-enabled (Cloudflare's current one-way exports gap).
 * The builder class is deliberately absent because its sidecar is never reset
 * during preview-slot handover.
 */
export const OS_CONTAINER_CLASS_NAMES = [
  ...SANDBOX_INSTANCE_TYPES.map(
    (instanceType) => SANDBOX_INSTANCE_TYPE_BINDINGS[instanceType].className,
  ),
];
