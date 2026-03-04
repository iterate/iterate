import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
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

describe.runIf(runFly)("fly deployment smoke", () => {
  test("creates deployment and all core processes become healthy", async () => {
    await using deployment = await FlyDeployment.create(flyOpts("fly-smoke"));

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
