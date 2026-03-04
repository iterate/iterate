import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { ordersServiceManifest } from "@iterate-com/orders-contract";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { localHostForService } from "@iterate-com/shared/jonasland";

const DOCKER_IMAGE = process.env.JONASLAND_E2E_DOCKER_IMAGE ?? "";

describe.runIf(DOCKER_IMAGE.length > 0)("docker on-demand orders oRPC", () => {
  test("start orders service via pidnap, exercise typed oRPC client", async () => {
    await using deployment = await DockerDeployment.create({
      dockerImage: DOCKER_IMAGE,
      name: `e2e-orders-${randomUUID().slice(0, 8)}`,
    });
    await deployment.waitUntilAlive({ signal: AbortSignal.timeout(15_000) });

    const slug = ordersServiceManifest.slug;
    const port = ordersServiceManifest.port;
    console.log(`[test] starting ${slug} on port ${String(port)}...`);

    await deployment.pidnap.processes.updateConfig({
      processSlug: slug,
      definition: {
        command: "node",
        args: ["--experimental-strip-types", ordersServiceManifest.serverEntryPoint],
        env: { PORT: String(port) },
      },
      tags: ["on-demand"],
      restartImmediately: true,
      healthCheck: {
        url: `http://127.0.0.1:${String(port)}/api/service/health`,
        intervalMs: 2_000,
      },
    });

    const waitResult = await deployment.pidnap.processes.waitFor({
      processes: { [slug]: "running" },
      timeoutMs: 3_000,
    });
    expect(waitResult.allMet).toBe(true);

    const host = localHostForService({ slug });
    const orders = deployment.createServiceClient({ manifest: ordersServiceManifest, host });

    const pingDeadline = Date.now() + 6_000;
    let ping: Awaited<ReturnType<typeof orders.orders.ping>> | null = null;
    while (Date.now() < pingDeadline) {
      try {
        ping = await orders.orders.ping({});
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (!ping) {
      const procs = await deployment.pidnap.processes.list();
      const ordersProc = procs.find((proc) => proc.name === slug);
      const logs = await deployment.logs();
      const tail = logs.split("\n").slice(-60).join("\n");
      throw new Error(
        `orders service did not respond to ping within 6s; process=${JSON.stringify(ordersProc)}\nlogs:\n${tail}`,
      );
    }
    expect(ping.ok).toBe(true);

    const placed = await orders.orders.place({
      sku: `sku-${randomUUID().slice(0, 6)}`,
      quantity: 2,
    });
    expect(placed.status).toBe("accepted");

    const listed = await orders.orders.list({ limit: 20 });
    expect(listed.total).toBeGreaterThanOrEqual(1);
    expect(listed.orders.some((order) => order.id === placed.id)).toBe(true);
  }, 30_000);
});
