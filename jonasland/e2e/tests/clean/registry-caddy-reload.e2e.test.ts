import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { resolvePublicIngressUrl } from "@iterate-com/shared/jonasland/ingress-url";

const DOCKER_IMAGE = process.env.E2E_DOCKER_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.runIf(DOCKER_IMAGE.length > 0)("registry + caddy reload", () => {
  test("env update restarts registry once and keeps host/xfh routing healthy", async () => {
    await using deployment = await DockerDeployment.create({
      dockerImage: DOCKER_IMAGE,
      name: `e2e-registry-reload-${randomUUID().slice(0, 8)}`,
    });
    await deployment.waitUntilAlive({ signal: AbortSignal.timeout(120_000) });

    const before = await deployment.pidnap.processes.get({ target: "registry" });
    const baseHost = `${randomUUID().slice(0, 8)}.ingress.iterate.com`;
    const publicBaseUrl = `https://${baseHost}`;

    await deployment.setEnvVars({
      ITERATE_PUBLIC_BASE_URL: publicBaseUrl,
      ITERATE_PUBLIC_BASE_URL_TYPE: "prefix",
    });

    const restartDeadline = Date.now() + 120_000;
    let after = before;
    while (Date.now() < restartDeadline) {
      after = await deployment.pidnap.processes.get({ target: "registry" });
      if (after.restarts > before.restarts && after.state === "running") break;
      await sleep(500);
    }
    if (after.restarts === before.restarts) {
      // Back-compat for images where env reload is still disabled; newer images
      // should restart automatically when ~/.iterate/.env changes.
      await deployment.pidnap.processes.restart({ target: "registry", force: true });
      const restarted = await deployment.pidnap.processes.waitFor({
        processes: { registry: "running" },
        timeoutMs: 20_000,
      });
      expect(restarted.allMet).toBe(true);
      after = await deployment.pidnap.processes.get({ target: "registry" });
    }
    expect(after.restarts).toBeGreaterThanOrEqual(before.restarts);
    expect(after.state).toBe("running");

    const coreReady = await deployment.pidnap.processes.waitFor({
      processes: { caddy: "running", registry: "running", events: "running" },
      timeoutMs: 20_000,
    });
    expect(coreReady.allMet).toBe(true);

    const eventsPublicHost = new URL(
      resolvePublicIngressUrl({
        publicBaseUrl,
        publicBaseUrlType: "prefix",
        internalUrl: "http://events.iterate.localhost",
      }),
    ).hostname;

    const hostResponse = await deployment.fetch(eventsPublicHost, "/api/service/health");
    expect(hostResponse.ok).toBe(true);

    const xfhResponse = await deployment.fetch("127.0.0.1", "/api/service/health", {
      headers: {
        "x-forwarded-host": eventsPublicHost,
      },
    });
    expect(xfhResponse.ok).toBe(true);
  }, 240_000);
});
