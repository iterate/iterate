import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { projectDeployment } from "../test-helpers/index.ts";

const RUN_E2E = process.env.RUN_JONASLAND_E2E === "true";
const E2E_PROVIDER = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const RUN_FLY_E2E = RUN_E2E && E2E_PROVIDER === "fly";

const image =
  process.env.JONASLAND_E2E_FLY_IMAGE ??
  process.env.FLY_DEFAULT_IMAGE ??
  process.env.JONASLAND_SANDBOX_IMAGE ??
  "";

describe.runIf(RUN_FLY_E2E)("jonasland fly e2e", () => {
  test("boots Fly machine and resolves public URL through registry", async () => {
    if (image.trim().length === 0) {
      throw new Error("Set JONASLAND_E2E_FLY_IMAGE or FLY_DEFAULT_IMAGE for Fly e2e");
    }

    await using deployment = await projectDeployment({
      image,
      name: `jonasland-e2e-fly-${randomUUID().slice(0, 8)}`,
    });

    const ingress = await deployment.ingressUrl();
    await deployment.waitForHealthyWithLogs({ url: `${ingress}/` });

    const publicEventsHealth = await deployment.registry.getPublicURL({
      internalURL: "http://events.iterate.localhost/healthz",
    });

    const response = await fetch(publicEventsHealth.publicURL);
    const body = await response.text();

    expect(response.ok).toBe(true);
    expect(body).toContain('"ok":true');
  }, 180_000);
});
