import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { exampleServiceManifest } from "@iterate-com/example-contract";
import { serviceManifestToPidnapConfig } from "@iterate-com/shared/jonasland";
import type { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { FlyDeployment } from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";

const DOCKER_IMAGE = process.env.E2E_DOCKER_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const FLY_IMAGE = process.env.E2E_FLY_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const FLY_API_TOKEN = process.env.FLY_API_TOKEN ?? "";
const runFly = FLY_IMAGE.length > 0 && FLY_API_TOKEN.length > 0;

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
          signal: AbortSignal.timeout(45_000 + timeoutOffsetMs),
        });

        await deployment.waitUntilAlive({
          signal: AbortSignal.timeout(15_000 + timeoutOffsetMs),
        });

        const pidnapConfigInputs = serviceManifestToPidnapConfig({
          manifests: [exampleServiceManifest],
        });
        for (const configInput of pidnapConfigInputs) {
          await deployment.pidnap.processes.updateConfig(configInput);
        }

        const waitResult = await deployment.pidnap.processes.waitFor({
          processes: { [exampleServiceManifest.slug]: "healthy" },
          timeoutMs: 60_000 + timeoutOffsetMs,
        });
        expect(waitResult.allMet).toBe(true);

        // example service self-registers with registry on listen; wait until the host route exists
        // before exercising the typed client through caddy host routing.
        const expectedExampleHost = "example.iterate.localhost";
        const routeDeadline = Date.now() + 60_000;
        let routeReady = false;
        while (Date.now() < routeDeadline) {
          const listedRoutes = await deployment.registry.routes.list({});
          routeReady = listedRoutes.routes.some((route) => route.host === expectedExampleHost);
          if (routeReady) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        expect(routeReady).toBe(true);

        let ping:
          | {
              ok: true;
              service: string;
            }
          | undefined;
        let lastPingError = "";
        const pingDeadline = Date.now() + (120_000 + timeoutOffsetMs);
        while (Date.now() < pingDeadline) {
          const response = await deployment
            .fetch(expectedExampleHost, "/api/things/ping")
            .catch((error) => {
              lastPingError = error instanceof Error ? error.message : String(error);
              return undefined;
            });
          if (!response) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          if (!response.ok) {
            lastPingError = `status=${String(response.status)}`;
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          ping = (await response.json()) as { ok: true; service: string };
          if (ping?.ok) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        expect(ping?.ok, `last ping error: ${lastPingError}`).toBe(true);

        const createdResponse = await deployment.fetch(expectedExampleHost, "/api/things", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ thing: `thing-${randomUUID().slice(0, 6)}` }),
        });
        expect(createdResponse.ok).toBe(true);
        const created = (await createdResponse.json()) as { id: string; thing: string };
        expect(created.thing.length).toBeGreaterThan(0);

        const listedResponse = await deployment.fetch(expectedExampleHost, "/api/things?limit=20");
        expect(listedResponse.ok).toBe(true);
        const listed = (await listedResponse.json()) as {
          things: Array<{ id: string }>;
          total: number;
        };
        expect(listed.things.some((thing) => thing.id === created.id)).toBe(true);

        const updatedResponse = await deployment.fetch(
          expectedExampleHost,
          `/api/things/${created.id}`,
          {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({ id: created.id, thing: "updated thing" }),
          },
        );
        expect(updatedResponse.ok).toBe(true);
        const updated = (await updatedResponse.json()) as { thing: string };
        expect(updated.thing).toBe("updated thing");

        const removedResponse = await deployment.fetch(
          expectedExampleHost,
          `/api/things/${created.id}`,
          {
            method: "DELETE",
          },
        );
        expect(removedResponse.ok).toBe(true);
        const removed = (await removedResponse.json()) as { deleted: boolean };
        expect(removed.deleted).toBe(true);

        const delayedStreamPath = `example/tests/${randomUUID().slice(0, 8)}`;
        const delayedType = "https://events.iterate.com/example/test-delayed";
        const delayedResponse = await deployment.fetch(
          expectedExampleHost,
          "/api/things/test/delayed-publish",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              streamPath: delayedStreamPath,
              type: delayedType,
              delayMs: 250,
              payload: { source: "e2e" },
            }),
          },
        );
        expect(delayedResponse.ok).toBe(true);
        const delayed = (await delayedResponse.json()) as {
          accepted: true;
          streamPath: string;
        };
        expect(delayed.accepted).toBe(true);
        expect(delayed.streamPath.length).toBeGreaterThan(0);

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
