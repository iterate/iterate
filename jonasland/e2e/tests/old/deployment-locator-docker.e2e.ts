import { describe, expect, test } from "vitest";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment";

const E2E_PROVIDER = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const RUN_DOCKER_E2E = E2E_PROVIDER === "docker";
const DOCKER_IMAGE = process.env.JONASLAND_E2E_DOCKER_IMAGE ?? "jonasland-sandbox:local";

function slugifyForName(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 48);
}

function deploymentNameForCurrentTest(): string {
  const currentTestName = expect.getState().currentTestName ?? "unnamed-test";
  const workerId = process.env.VITEST_WORKER_ID ?? "0";
  const slug = slugifyForName(currentTestName);
  return `jonasland-locator-docker-${workerId}-${slug}`;
}

describe.runIf(RUN_DOCKER_E2E)("deployment abstraction locator (docker)", () => {
  test("can create, attach with deploymentLocator, and interact", async () => {
    const deployment = new DockerDeployment();
    const deploymentLocator = await deployment.create({
      dockerImage: DOCKER_IMAGE,
      name: deploymentNameForCurrentTest(),
    });

    expect(deploymentLocator.provider).toBe("docker");
    expect(deploymentLocator.containerId.length).toBeGreaterThan(0);

    const ownerHealth = await deployment.exec(["curl", "-fsS", "http://127.0.0.1/healthz"]);
    expect(ownerHealth.exitCode).toBe(0);
    expect(ownerHealth.output.trim()).toBe("caddy ok");

    await using attached = new DockerDeployment();
    await attached.attach(deploymentLocator);

    const attachedHealth = await attached.exec(["curl", "-fsS", "http://127.0.0.1/healthz"]);
    expect(attachedHealth.exitCode).toBe(0);
    expect(attachedHealth.output.trim()).toBe("caddy ok");

    const ownerStillHealthy = await deployment.exec(["curl", "-fsS", "http://127.0.0.1/healthz"]);
    expect(ownerStillHealthy.exitCode).toBe(0);

    await deployment[Symbol.asyncDispose]();

    const attachAfterDestroy = new DockerDeployment();
    await expect(attachAfterDestroy.attach(deploymentLocator)).rejects.toThrow();
  }, 900_000);
});
