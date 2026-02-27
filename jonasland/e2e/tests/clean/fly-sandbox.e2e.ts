import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { FlyDeployment } from "@iterate-com/shared/jonasland/deployment";

const providerEnv = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const runFly = providerEnv === "fly" || providerEnv === "all";
const image = process.env.JONASLAND_E2E_FLY_IMAGE ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";

describe.runIf(runFly)("clean fly sandbox", () => {
  test("creates deployment, becomes healthy, and disposes", async () => {
    if (image.trim().length === 0) {
      throw new Error("Set JONASLAND_E2E_FLY_IMAGE or JONASLAND_SANDBOX_IMAGE for Fly tests");
    }

    let step = "create deployment";
    let deployment:
      | Awaited<ReturnType<ReturnType<typeof FlyDeployment.withConfig>["create"]>>
      | undefined;

    try {
      deployment = await FlyDeployment.withConfig({
        image,
      }).create({
        name: `jonasland-e2e-clean-fly-sandbox-${randomUUID().slice(0, 8)}`,
      });

      step = "provider status";
      expect(await deployment.providerStatus()).toBe("running");

      step = "resolve ingress";
      const ingress = await deployment.ingressUrl();

      step = "ingress health";
      await deployment.waitForHealthyWithLogs({ url: `${ingress}/healthz` });

      step = "complete";
    } catch (error) {
      const logs =
        deployment !== undefined
          ? await deployment
              .logs()
              .catch(
                (logsError) =>
                  `failed to fetch deployment logs: ${logsError instanceof Error ? logsError.message : String(logsError)}`,
              )
          : "deployment was not created";

      throw new Error(`clean fly sandbox failed during: ${step}\nlogs:\n${logs}`, { cause: error });
    } finally {
      if (deployment !== undefined) {
        await deployment[Symbol.asyncDispose]();
      }
    }
  }, 600_000);
});
