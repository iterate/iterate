import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { FlyDeployment } from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";

const FLY_IMAGE = process.env.JONASLAND_E2E_FLY_IMAGE ?? "";
const providerEnv = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const runFly = (providerEnv === "fly" || providerEnv === "all") && FLY_IMAGE.length > 0;

describe.runIf(runFly)("fly sandbox", () => {
  test("creates deployment, becomes healthy, and disposes", async () => {
    await using deployment = await FlyDeployment.create({
      flyImage: FLY_IMAGE,
      flyApiToken: process.env.FLY_API_TOKEN!,
      flyBaseDomain: process.env.FLY_BASE_DOMAIN ?? "fly.dev",
      name: `e2e-fly-sandbox-${randomUUID().slice(0, 8)}`,
    });

    await deployment.waitUntilAlive({ signal: AbortSignal.timeout(300_000) });

    const health = await fetch(`${deployment.baseUrl}/healthz`);
    expect(health.ok).toBe(true);

    const procs = await deployment.pidnap.processes.list();
    expect(procs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "caddy" }),
        expect.objectContaining({ name: "registry" }),
        expect.objectContaining({ name: "events" }),
      ]),
    );
  }, 600_000);
});
