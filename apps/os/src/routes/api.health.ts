import { createFileRoute } from "@tanstack/react-router";
import { DurableObjectNameCodec } from "../domains/durable-object-names.ts";
import { workerBuildDeployment } from "../domains/workers/worker-build-capability.ts";
import { workerBuildReadinessResponse } from "../domains/workers/worker-build-readiness.ts";
import { itxEnv, workerVersion } from "../env.ts";

/**
 * Deployment readiness probe. The main version is healthy only when its
 * capability-host Durable Object runs the same code and its route-less
 * worker-build service answers with the same immutable deployment identity.
 */
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: () => {
        const version = workerVersion(itxEnv);
        // One read-only sentinel per Worker version exercises a freshly placed
        // instance of the exact Durable Object class used by deployed e2e. It
        // emits no domain events or writes. An old incarnation either lacks
        // deploymentVersion() or reports its old version, so eventual-
        // consistency during code rollout fails closed.
        const capabilityHost = itxEnv.CAPABILITY_HOST.getByName(
          DurableObjectNameCodec.stringify({
            path: "/",
            projectId: "prj_deployment_readiness",
            props: { version },
          }),
        );
        return workerBuildReadinessResponse({
          expectedDeploymentId: itxEnv.WORKER_BUILD_DEPLOYMENT_ID,
          readDeployment: workerBuildDeployment,
          readDurableObjectVersion: () => capabilityHost.deploymentVersion(),
          version,
        });
      },
    },
  },
});
