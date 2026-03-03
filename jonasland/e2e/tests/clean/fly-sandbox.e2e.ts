import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { FlyDeployment } from "@iterate-com/shared/jonasland/deployment";
import { waitForBuiltInServicesOnline } from "../../test-helpers/deployment-bootstrap.ts";

const providerEnv = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const runFly = providerEnv === "fly" || providerEnv === "all";
const FLY_IMAGE = process.env.JONASLAND_E2E_FLY_IMAGE ?? "";

describe.runIf(runFly)("clean fly sandbox", () => {
  test("creates deployment, becomes healthy, and disposes", async () => {
    if (FLY_IMAGE.trim().length === 0) {
      throw new Error("Set JONASLAND_E2E_FLY_IMAGE for Fly tests");
    }

    let step = "create deployment";
    let deployment: FlyDeployment | undefined;

    try {
      deployment = await FlyDeployment.createWithConfig({
        flyImage: FLY_IMAGE,
      }).create({
        name: `jonasland-e2e-clean-fly-sandbox-${randomUUID().slice(0, 8)}`,
      });

      step = "provider status";
      expect(await deployment.providerStatus()).toBe("running");

      step = "wait built-ins";
      await waitForBuiltInServicesOnline({ deployment });

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
                (logsError: unknown) =>
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
