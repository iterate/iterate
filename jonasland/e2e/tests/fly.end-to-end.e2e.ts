import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { FlyDeployment } from "@iterate-com/shared/jonasland/deployment";

const E2E_PROVIDER = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const RUN_FLY_E2E = E2E_PROVIDER === "fly";

const FLY_IMAGE = process.env.JONASLAND_E2E_FLY_IMAGE ?? "";

async function fetchWithRetry(url: string, timeoutMs = 30_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`timed out fetching ${url}`, { cause: lastError });
}

describe.runIf(RUN_FLY_E2E)("jonasland fly e2e", () => {
  test("boots Fly machine and resolves public URL through registry", async () => {
    if (FLY_IMAGE.trim().length === 0) {
      throw new Error("Set JONASLAND_E2E_FLY_IMAGE for Fly e2e");
    }

    let step = "create deployment";
    try {
      await using deployment = await FlyDeployment.createWithConfig({
        flyImage: FLY_IMAGE,
        name: `jonasland-e2e-fly-${randomUUID().slice(0, 8)}`,
      }).create();

      step = "resolve ingress";
      const ingress = await deployment.ingressUrl();

      step = "wait for ingress healthy";
      await deployment.waitForHealthyWithLogs({ url: `${ingress}/healthz` });

      step = "resolve public url";
      const internalURL = `${ingress}/healthz`;
      const publicServiceHealth = await deployment.registry.getPublicURL({
        internalURL,
      });

      step = "fetch public service health";
      const response = await fetchWithRetry(publicServiceHealth.publicURL, 120_000);
      const body = await response.text();

      expect(response.ok).toBe(true);
      expect(body).toContain("ok");
    } catch (error) {
      throw new Error(`fly e2e failed during: ${step}`, { cause: error });
    }
  }, 600_000);
});
