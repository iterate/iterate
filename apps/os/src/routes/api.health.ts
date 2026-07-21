import { createFileRoute } from "@tanstack/react-router";
import {
  deploymentReadinessProbeIndexes,
  deploymentReadinessProbeQueryParam,
  deploymentReadinessProbeWave,
  deploymentReadinessResponse,
} from "../deployment-readiness.ts";
import { DurableObjectNameCodec } from "../domains/durable-object-names.ts";
import { itxEnv, workerVersion } from "../env.ts";

const workerVersionHeader = "x-iterate-worker-version";

/**
 * Cheap liveness by default. Preview deploys add a bounded query wave; that
 * path samples every Durable Object namespace and returns 503 until each
 * sampled incarnation runs the exact edge Worker version.
 */
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const version = workerVersion(itxEnv);
        const probeSequence = new URL(request.url).searchParams.get(
          deploymentReadinessProbeQueryParam,
        );
        if (probeSequence !== null) {
          const probeWave = deploymentReadinessProbeWave(probeSequence);
          const probeIndexes = deploymentReadinessProbeIndexes(probeWave);

          // CapabilityHost gets broad, version-specific placement coverage.
          // Every other namespace uses one fixed identity per wave: waking
          // those incarnations absorbs the namespace's code transition here
          // without leaking durable state on every deploy. The sole RPC below
          // reads a version; sandbox probes never create or start containers.
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
          const probes = [
            ...probeIndexes.map((probe) =>
              itxEnv.CAPABILITY_HOST.getByName(
                DurableObjectNameCodec.stringify({
                  path: "/",
                  projectId: "prj_deployment_readiness",
                  props: { probe: String(probe), version },
                }),
              ),
            ),
            itxEnv.AGENT.getByName(projectProbeName("/agents/deployment-readiness")),
            itxEnv.AGENT_COLLECTION.getByName(projectProbeName("/agents")),
            itxEnv.DEVICE.getByName(projectProbeName("/devices/deployment-readiness")),
            itxEnv.PROJECT.getByName(projectProbeName("/")),
            itxEnv.REPO.getByName(projectProbeName("/repos/deployment-readiness")),
            itxEnv.SCHEDULER.getByName(projectProbeName("/scheduler/deployment-readiness")),
            itxEnv.SECRET.getByName(projectProbeName("/secrets/deployment-readiness")),
            itxEnv.STREAM.getByName(streamProbeName),
            itxEnv.WORKER.getByName(projectProbeName("/workers/deployment-readiness")),
            itxEnv.WORKSPACE_V2.getByName(projectProbeName("/workspaces/deployment-readiness")),
            itxEnv.SANDBOX_LITE.getByName(projectProbeName("/sandboxes/deployment-readiness")),
            itxEnv.SANDBOX_BASIC.getByName(projectProbeName("/sandboxes/deployment-readiness")),
            itxEnv.SANDBOX_STANDARD_1.getByName(
              projectProbeName("/sandboxes/deployment-readiness"),
            ),
            itxEnv.SANDBOX_STANDARD_2.getByName(
              projectProbeName("/sandboxes/deployment-readiness"),
            ),
            itxEnv.SANDBOX_STANDARD_3.getByName(
              projectProbeName("/sandboxes/deployment-readiness"),
            ),
            itxEnv.SANDBOX_STANDARD_4.getByName(
              projectProbeName("/sandboxes/deployment-readiness"),
            ),
          ];

          return deploymentReadinessResponse({
            app: "os",
            readDurableObjectVersions: () =>
              Promise.all(probes.map((probe) => probe.deploymentVersion())),
            version,
          });
        }

        return Response.json(
          { ok: true, app: "os", version },
          {
            headers: {
              "cache-control": "no-store",
              [workerVersionHeader]: version,
            },
          },
        );
      },
    },
  },
});
