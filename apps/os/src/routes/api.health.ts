import { createFileRoute } from "@tanstack/react-router";
import { parseConfig } from "../config.ts";
import {
  deploymentReadinessProbeIndexes,
  deploymentReadinessProjectProbes,
  deploymentReadinessProbeQueryParam,
  deploymentReadinessProbeWave,
  deploymentReadinessRequestAuthorized,
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
      GET: async ({ request }) => {
        const version = workerVersion(itxEnv);
        const probeSequence = new URL(request.url).searchParams.get(
          deploymentReadinessProbeQueryParam,
        );
        if (probeSequence !== null) {
          const expectedToken = parseConfig(itxEnv).adminApiSecret?.exposeSecret();
          if (!deploymentReadinessRequestAuthorized(request, expectedToken)) {
            return probeErrorResponse({ error: "unauthorized", status: 401, version });
          }

          const probeWave = deploymentReadinessProbeWave(probeSequence);
          if (probeWave === null) {
            return probeErrorResponse({ error: "invalid-probe-wave", status: 400, version });
          }
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
            ...probeIndexes.map((probe) => {
              const stub = itxEnv.CAPABILITY_HOST.getByName(
                DurableObjectNameCodec.stringify({
                  path: "/",
                  projectId: "prj_deployment_readiness",
                  props: { probe: String(probe), version },
                }),
              );
              return {
                name: `CAPABILITY_HOST:${probe}`,
                readVersion: () => stub.deploymentVersion(),
              };
            }),
            ...deploymentReadinessProjectProbes.map(([binding, path]) => {
              const stub = itxEnv[binding].getByName(projectProbeName(path));
              return { name: binding, readVersion: () => stub.deploymentVersion() };
            }),
            {
              name: "STREAM",
              readVersion: () => itxEnv.STREAM.getByName(streamProbeName).deploymentVersion(),
            },
          ];

          return await deploymentReadinessResponse({
            app: "os",
            probes,
            version,
            wave: probeWave,
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

function probeErrorResponse(input: { error: string; status: number; version: string }) {
  return Response.json(
    { ok: false, app: "os", error: input.error, version: input.version },
    {
      status: input.status,
      headers: {
        "cache-control": "no-store",
        [workerVersionHeader]: input.version,
      },
    },
  );
}
