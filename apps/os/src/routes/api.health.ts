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
        const probeWave = deploymentReadinessProbeWave(probeSequence);
        const probeIndexes =
          version === "unversioned" ? [0] : deploymentReadinessProbeIndexes(probeWave);

        // Each wave exercises eight version-specific CapabilityHost placements
        // plus one fixed incarnation in every other main-worker Durable Object
        // namespace. Cloudflare can roll namespaces at different times: a
        // CapabilityHost-only barrier let fresh Project, Repo, Stream, and
        // Sandbox objects reset under the first e2e wave. The fixed probes make
        // each namespace absorb that lifecycle transition here. Successive
        // polls rotate through ten bounded names, while the version-specific
        // CapabilityHost samples retain the wider placement coverage needed by
        // deployed scripts. The global Stream probe avoids configuring a
        // project subscriber; its normal incarnation wake is the only domain
        // lifecycle work these otherwise read-only methods trigger.
        const capabilityHosts = probeIndexes.map((probe) =>
          itxEnv.CAPABILITY_HOST.getByName(
            DurableObjectNameCodec.stringify({
              path: "/",
              projectId: "prj_deployment_readiness",
              props: { probe: String(probe), version },
            }),
          ),
        );
        const projectProbeName = (path: string) =>
          DurableObjectNameCodec.stringify({
            path,
            projectId: "prj_deployment_readiness",
            props: { probe: String(probeWave) },
          });
        const streamProbeName = DurableObjectNameCodec.stringify(
          {
            path: "/deployment-readiness",
            projectId: null,
            props: { probe: String(probeWave) },
          },
          { allowNullProjectId: true },
        );
        const namespaceVersionProbes = [
          itxEnv.AGENT.getByName(projectProbeName("/agents/deployment-readiness")),
          itxEnv.AGENT_COLLECTION.getByName(projectProbeName("/agents")),
          itxEnv.PROJECT.getByName(projectProbeName("/")),
          itxEnv.REPO.getByName(projectProbeName("/repos/deployment-readiness")),
          itxEnv.SCHEDULER.getByName(projectProbeName("/scheduler/deployment-readiness")),
          itxEnv.SECRET.getByName(projectProbeName("/secrets/deployment-readiness")),
          itxEnv.STREAM.getByName(streamProbeName),
          itxEnv.WORKER.getByName(projectProbeName("/workers/deployment-readiness")),
          itxEnv.WORKSPACE_V2.getByName(projectProbeName("/workspaces/deployment-readiness")),
          itxEnv.SANDBOX_LITE.getByName(projectProbeName("/sandboxes/deployment-readiness")),
          itxEnv.SANDBOX_BASIC.getByName(projectProbeName("/sandboxes/deployment-readiness")),
          itxEnv.SANDBOX_STANDARD_1.getByName(projectProbeName("/sandboxes/deployment-readiness")),
          itxEnv.SANDBOX_STANDARD_2.getByName(projectProbeName("/sandboxes/deployment-readiness")),
          itxEnv.SANDBOX_STANDARD_3.getByName(projectProbeName("/sandboxes/deployment-readiness")),
          itxEnv.SANDBOX_STANDARD_4.getByName(projectProbeName("/sandboxes/deployment-readiness")),
        ];
        return workerBuildReadinessResponse({
          expectedDeploymentId: itxEnv.WORKER_BUILD_DEPLOYMENT_ID,
          sandboxContainerDeploymentId: itxEnv.SANDBOX_CONTAINER_DEPLOYMENT_ID,
          readDeployment: workerBuildDeployment,
          readDurableObjectVersions: () =>
            Promise.all(
              [...capabilityHosts, ...namespaceVersionProbes].map((durableObject) =>
                durableObject.deploymentVersion(),
              ),
            ),
          version,
        });
      },
    },
  },
});
