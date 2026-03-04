import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { ordersServiceManifest } from "@iterate-com/orders-contract";
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
    timeoutOffsetMs: 570_000,
  },
].filter((entry) => entry.enabled);

describe.runIf(cases.length > 0)("on-demand orders oRPC", () => {
  describe.each(cases)("$id", ({ create, timeoutOffsetMs }) => {
    test(
      "start orders service via pidnap, exercise typed oRPC client",
      async () => {
        await using deployment = await create({
          name: `e2e-orders-${randomUUID().slice(0, 8)}`,
          signal: AbortSignal.timeout(45_000 + timeoutOffsetMs),
        });
        await deployment.waitUntilAlive({ signal: AbortSignal.timeout(15_000 + timeoutOffsetMs) });

        console.log(
          `[test] starting ${ordersServiceManifest.slug} on port ${String(ordersServiceManifest.port)}...`,
        );

        await deployment.pidnap.processes.updateConfig(
          serviceManifestToPidnapConfig({ manifest: ordersServiceManifest }),
        );

        const waitResult = await deployment.pidnap.processes.waitFor({
          processes: { [ordersServiceManifest.slug]: "healthy" },
          timeoutMs: 20_000 + timeoutOffsetMs,
        });
        expect(waitResult.allMet).toBe(true);

        const orders = deployment.createServiceClient({ manifest: ordersServiceManifest });

        const ping = await orders.orders.ping({});
        expect(ping.ok).toBe(true);

        const placed = await orders.orders.place({
          sku: `sku-${randomUUID().slice(0, 6)}`,
          quantity: 2,
        });
        expect(placed.status).toBe("accepted");

        const listed = await orders.orders.list({ limit: 20 });
        expect(listed.total).toBeGreaterThanOrEqual(1);
        expect(listed.orders.some((order) => order.id === placed.id)).toBe(true);
      },
      120_000 + timeoutOffsetMs,
    );
  });
});
