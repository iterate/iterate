import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { ordersServiceManifest } from "@iterate-com/orders-contract";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment";
import {
  startOnDemandServiceViaPidnap,
  waitForBuiltInServicesOnline,
} from "../../test-helpers/deployment-bootstrap.ts";

const DOCKER_IMAGE = process.env.JONASLAND_E2E_DOCKER_IMAGE ?? "jonasland-sandbox:local";
const providerEnv = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const runDocker = providerEnv === "docker" || providerEnv === "all";
const dockerAccessModes = new Set(
  (process.env.JONASLAND_E2E_DOCKER_ACCESS_MODES ?? "local")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0),
);
const runDockerLocal =
  runDocker &&
  (dockerAccessModes.has("all") || dockerAccessModes.has("local") || dockerAccessModes.size === 0);

describe.runIf(runDockerLocal)("clean docker on-demand orders oRPC", () => {
  test("create deployment, wait built-ins, start orders, use typed client", async () => {
    await using deployment = await DockerDeployment.create({
      dockerImage: DOCKER_IMAGE,
      name: `jonasland-e2e-orders-ondemand-${randomUUID().slice(0, 8)}`,
    });

    await waitForBuiltInServicesOnline({ deployment });

    await startOnDemandServiceViaPidnap({
      deployment,
      processSlug: "orders",
      definition: {
        command: "/opt/pidnap/node_modules/.bin/tsx",
        args: ["/opt/services/orders-service/src/server.ts"],
        env: {
          ORDERS_SERVICE_PORT: "19020",
          EVENTS_SERVICE_BASE_URL: "http://127.0.0.1:19010/orpc",
          SERVICES_ORPC_URL: "http://127.0.0.1:8777/orpc",
        },
      },
      healthHost: "orders.iterate.localhost",
      healthPath: "/healthz",
    });

    await deployment.registry.routes.upsert({
      host: "orders.iterate.localhost",
      target: "127.0.0.1:19020",
      metadata: {
        openapiPath: "/api/openapi.json",
        title: "Orders Service",
      },
      tags: ["orders", "openapi"],
    });

    const orders = deployment.createServiceOrpcClient({ manifest: ordersServiceManifest });

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
  }, 300_000);
});
