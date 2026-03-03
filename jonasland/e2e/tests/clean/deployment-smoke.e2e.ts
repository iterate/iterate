import { describe, expect, test } from "vitest";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";

const image = process.env.JONASLAND_E2E_DOCKER_IMAGE ?? "";

describe.runIf(image.length > 0)("deployment smoke", () => {
  test("creates deployment and all core processes become healthy", async () => {
    await using deployment = await DockerDeployment.create({ dockerImage: image });

    await deployment.waitUntilAlive({ signal: AbortSignal.timeout(90_000) });

    const health = await fetch(`${deployment.baseUrl}/healthz`);
    expect(health.ok).toBe(true);

    const procs = await deployment.pidnap.processes.list();
    expect(procs).toEqual(expect.arrayContaining([expect.objectContaining({ name: "caddy" })]));
  }, 120_000);
});
