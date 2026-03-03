import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  DockerDeployment,
  FlyDeployment,
  type Deployment,
} from "@iterate-com/shared/jonasland/deployment";

type ProviderName = "docker" | "fly";

type ProviderCase = {
  name: ProviderName;
  enabled: boolean;
  create: () => Promise<Deployment>;
};

const providerEnv = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const runAllProviders = providerEnv === "all";

const DOCKER_IMAGE = process.env.JONASLAND_E2E_DOCKER_IMAGE ?? "jonasland-sandbox:local";
const FLY_IMAGE = process.env.JONASLAND_E2E_FLY_IMAGE ?? "";

const providerCases: ProviderCase[] = [
  {
    name: "docker",
    enabled: runAllProviders || providerEnv === "docker",
    create: async () =>
      await DockerDeployment.createWithOpts({
        dockerImage: DOCKER_IMAGE,
      }).create({
        name: `jonasland-e2e-deployment-class-docker-${randomUUID().slice(0, 8)}`,
      }),
  },
  {
    name: "fly",
    enabled: (runAllProviders || providerEnv === "fly") && FLY_IMAGE.trim().length > 0,
    create: async () =>
      await FlyDeployment.createWithOpts({
        flyImage: FLY_IMAGE,
        flyApiToken: process.env.FLY_API_TOKEN!,
        flyBaseDomain: process.env.FLY_BASE_DOMAIN ?? "fly.dev",
      }).create({
        name: `jonasland-e2e-deployment-class-fly-${randomUUID().slice(0, 8)}`,
      }),
  },
];

for (const provider of providerCases) {
  describe.runIf(provider.enabled)(`deployment classes (${provider.name})`, () => {
    test("bootstraps and exposes shared clients", async () => {
      await using deployment = await provider.create();

      expect(await deployment.providerStatus()).toBe("running");
      expect(typeof deployment.pidnap.manager.status).toBe("function");
      expect(typeof deployment.registry.routes.list).toBe("function");
      expect(typeof deployment.caddy.getConfig).toBe("function");

      const managerStatus = await deployment.pidnap.manager.status();
      expect(managerStatus.state).toBe("running");
    }, 900_000);
  });
}
