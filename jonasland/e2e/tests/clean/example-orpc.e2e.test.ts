import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { exampleServiceManifest } from "@iterate-com/example-contract";
import { serviceManifestToPidnapConfig } from "@iterate-com/shared/jonasland";
import type { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import type { DockerHostSyncConfig } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { FlyDeployment } from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";

const DOCKER_IMAGE = process.env.E2E_DOCKER_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const FLY_IMAGE = process.env.E2E_FLY_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const FLY_API_TOKEN = process.env.FLY_API_TOKEN ?? "";
const runFly = FLY_IMAGE.length > 0 && FLY_API_TOKEN.length > 0;
const useDockerHostSync = process.env.DOCKER_HOST_SYNC_ENABLED === "true";
const DOCKER_HOST_SYNC_STARTUP_OFFSET_MS = useDockerHostSync ? 180_000 : 0;
const dockerHostSync: DockerHostSyncConfig | undefined =
  useDockerHostSync && process.env.DOCKER_HOST_GIT_REPO_ROOT
    ? {
        repoRoot: process.env.DOCKER_HOST_GIT_REPO_ROOT,
        gitDir: process.env.DOCKER_HOST_GIT_DIR,
        commonDir: process.env.DOCKER_HOST_GIT_COMMON_DIR,
      }
    : undefined;

type DeploymentCase = {
  id: string;
  enabled: boolean;
  create: (overrides?: { name?: string; signal?: AbortSignal }) => Promise<Deployment>;
  timeoutOffsetMs: number;
};

const cases: DeploymentCase[] = [
  {
    id: "docker-default",
    enabled: DOCKER_IMAGE.length > 0,
    create: async (overrides = {}) =>
      await DockerDeployment.create({
        dockerImage: DOCKER_IMAGE,
        ...(dockerHostSync ? { dockerHostSync } : {}),
        ...overrides,
      }),
    timeoutOffsetMs: 0,
  },
  {
    id: "fly-default",
    enabled: runFly,
    create: FlyDeployment.makeFactory({
      flyImage: FLY_IMAGE,
      flyApiToken: FLY_API_TOKEN,
    }),
    timeoutOffsetMs: 300_000,
  },
].filter((entry) => entry.enabled);

describe.runIf(cases.length > 0)("on-demand example oRPC", () => {
  describe.each(cases)("$id", ({ create, timeoutOffsetMs }) => {
    test(
      "start example service via pidnap, exercise CRUD + delayed publish",
      async () => {
        await using deployment = await create({
          name: `e2e-example-${randomUUID().slice(0, 8)}`,
          signal: AbortSignal.timeout(
            45_000 + timeoutOffsetMs + DOCKER_HOST_SYNC_STARTUP_OFFSET_MS,
          ),
        });
        await deployment.waitUntilAlive({
          signal: AbortSignal.timeout(
            15_000 + timeoutOffsetMs + DOCKER_HOST_SYNC_STARTUP_OFFSET_MS,
          ),
        });

        const pidnapConfigInputs = serviceManifestToPidnapConfig({
          manifests: [exampleServiceManifest],
        });
        for (const configInput of pidnapConfigInputs) {
          await deployment.pidnap.processes.updateConfig(configInput);
        }

        const waitResult = await deployment.pidnap.processes.waitFor({
          processes: { [exampleServiceManifest.slug]: "healthy" },
          timeoutMs: 120_000 + timeoutOffsetMs,
        });
        expect(waitResult.allMet).toBe(true);

        const example = deployment.createServiceClient({ manifest: exampleServiceManifest });

        let ping:
          | {
              ok: true;
              service: string;
            }
          | undefined;
        const pingDeadline = Date.now() + (120_000 + timeoutOffsetMs);
        while (Date.now() < pingDeadline) {
          ping = await example.things.ping({}).catch(() => undefined);
          if (ping?.ok) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        expect(ping?.ok).toBe(true);

        const created = await example.things.create({ thing: `thing-${randomUUID().slice(0, 6)}` });
        expect(created.thing.length).toBeGreaterThan(0);

        const listed = await example.things.list({ limit: 20 });
        expect(listed.things.some((thing) => thing.id === created.id)).toBe(true);

        const updated = await example.things.update({ id: created.id, thing: "updated thing" });
        expect(updated.thing).toBe("updated thing");

        const removed = await example.things.remove({ id: created.id });
        expect(removed.deleted).toBe(true);

        const delayedStreamPath = `example/tests/${randomUUID().slice(0, 8)}`;
        const delayedType = "https://events.iterate.com/example/test-delayed";
        const delayed = await example.things.delayedPublish({
          streamPath: delayedStreamPath,
          type: delayedType,
          delayMs: 250,
          payload: { source: "e2e" },
        });
        expect(delayed.accepted).toBe(true);

        const startedAt = Date.now();
        let found = false;
        const normalizedDelayedStreamPath = delayedStreamPath.replace(/^\/+/, "");
        while (Date.now() - startedAt < 30_000 + timeoutOffsetMs) {
          const streams = await deployment.events.listStreams({});
          found = streams.some(
            (stream) => stream.path.replace(/^\/+/, "") === normalizedDelayedStreamPath,
          );
          if (found) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(found).toBe(true);
      },
      180_000 + timeoutOffsetMs,
    );
  });
});
