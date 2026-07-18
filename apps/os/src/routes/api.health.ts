import { createFileRoute } from "@tanstack/react-router";
import { workerBuildDeployment } from "../domains/workers/worker-build-capability.ts";
import { workerBuildReadinessResponse } from "../domains/workers/worker-build-readiness.ts";
import { itxEnv, workerVersion } from "../env.ts";

/**
 * Deployment readiness probe. The main version is healthy only when its
 * route-less worker-build service answers with the same immutable deployment
 * identity; this keeps dynamic-worker tests behind sidecar propagation too.
 */
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: () =>
        workerBuildReadinessResponse({
          expectedDeploymentId: itxEnv.WORKER_BUILD_DEPLOYMENT_ID,
          readDeployment: workerBuildDeployment,
          version: workerVersion(itxEnv),
        }),
    },
  },
});
