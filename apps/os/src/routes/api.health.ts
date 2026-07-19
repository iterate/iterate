import { createFileRoute } from "@tanstack/react-router";
import { DurableObjectNameCodec } from "../domains/durable-object-names.ts";
import { workerBuildDeployment } from "../domains/workers/worker-build-capability.ts";
import {
  deploymentReadinessProbeIndexes,
  deploymentReadinessProbeQueryParam,
  deploymentReadinessProbeWave,
  workerBuildReadinessResponse,
} from "../domains/workers/worker-build-readiness.ts";
import { itxEnv, workerVersion } from "../env.ts";

/**
 * Deployment readiness probe. The main version is healthy only when its
 * capability-host Durable Object runs the same code and its route-less
 * worker-build service answers with the same immutable deployment identity.
 */
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const version = workerVersion(itxEnv);
        const probeSequence = new URL(request.url).searchParams.get(
          deploymentReadinessProbeQueryParam,
        );
        const probeIndexes =
          version === "unversioned"
            ? [0]
            : deploymentReadinessProbeIndexes(deploymentReadinessProbeWave(probeSequence));

        // Each wave exercises eight version-specific, read-only placements of
        // the exact Durable Object class used by deployed e2e. Successive
        // preview polls rotate through ten bounded waves, so one lucky current
        // incarnation cannot hide newly placed objects still receiving old
        // code. These calls emit no domain events or storage writes.
        const capabilityHosts = probeIndexes.map((probe) =>
          itxEnv.CAPABILITY_HOST.getByName(
            DurableObjectNameCodec.stringify({
              path: "/",
              projectId: "prj_deployment_readiness",
              props: { probe: String(probe), version },
            }),
          ),
        );
        return workerBuildReadinessResponse({
          expectedDeploymentId: itxEnv.WORKER_BUILD_DEPLOYMENT_ID,
          readDeployment: workerBuildDeployment,
          readDurableObjectVersions: () =>
            Promise.all(
              capabilityHosts.map((capabilityHost) => capabilityHost.deploymentVersion()),
            ),
          version,
        });
      },
    },
  },
});
