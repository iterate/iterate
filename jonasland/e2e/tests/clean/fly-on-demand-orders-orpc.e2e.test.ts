import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { ordersServiceManifest } from "@iterate-com/orders-contract";
import {
  FlyDeployment,
  type FlyDeploymentOpts,
} from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";

const FLY_IMAGE = process.env.JONASLAND_E2E_FLY_IMAGE ?? "";
const FLY_API_TOKEN = process.env.FLY_API_TOKEN ?? "";
const FLY_BASE_DOMAIN = process.env.FLY_BASE_DOMAIN ?? "fly.dev";
const runFly = FLY_IMAGE.length > 0 && FLY_API_TOKEN.length > 0;

function flyOpts(name: string, extra?: Partial<FlyDeploymentOpts>): FlyDeploymentOpts {
  return {
    flyImage: FLY_IMAGE,
    flyApiToken: FLY_API_TOKEN,
    flyBaseDomain: FLY_BASE_DOMAIN,
    name: `e2e-${name}-${randomUUID().slice(0, 8)}`,
    ...extra,
  };
}

describe.runIf(runFly)("fly on-demand orders oRPC", () => {
  test("start orders service via pidnap, exercise typed oRPC client", async () => {
    await using deployment = await FlyDeployment.create(flyOpts("fly-orders"));
    await deployment.waitUntilAlive({ signal: AbortSignal.timeout(300_000) });

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
      timeoutMs: 10_000,
    });
    expect(waitResult.allMet).toBe(true);

    const orders = deployment.createServiceClient({ manifest: ordersServiceManifest });

    const pingDeadline = Date.now() + 15_000;
    let ping: Awaited<ReturnType<typeof orders.orders.ping>> | null = null;
    while (Date.now() < pingDeadline) {
      try {
        ping = await orders.orders.ping({});
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!ping) {
      const procs = await deployment.pidnap.processes.list();
      const ordersProc = procs.find((proc) => proc.name === slug);
      const logs = await deployment.logs();
      const tail = logs.split("\n").slice(-60).join("\n");
      throw new Error(
        `orders service did not respond to ping within 15s; process=${JSON.stringify(ordersProc)}\nlogs:\n${tail}`,
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
  }, 600_000);
});
