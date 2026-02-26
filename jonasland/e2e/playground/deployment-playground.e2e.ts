import { describe, expect, test } from "vitest";
import {
  DockerDeployment,
  FlyDeployment,
  type Deployment,
  type DeploymentConfig,
  type DeploymentStartParams,
} from "../test-helpers/index.ts";

type DeploymentProvider<TDeployment extends Deployment = Deployment> = {
  implemented: boolean;
  name: string;
  new (config: DeploymentConfig): TDeployment;
};

async function createDeployment<TDeployment extends Deployment>(
  Provider: DeploymentProvider<TDeployment>,
  config: DeploymentConfig,
  startParams?: DeploymentStartParams,
): Promise<TDeployment> {
  const deployment = new Provider(config);
  await deployment.start(startParams);
  return deployment;
}

const RUN_E2E = process.env.RUN_JONASLAND_E2E === "true";
const DEFAULT_IMAGE = process.env.JONASLAND_SANDBOX_IMAGE ?? "jonasland-sandbox:local";
const FLY_IMAGE =
  process.env.JONASLAND_E2E_FLY_IMAGE ?? process.env.FLY_DEFAULT_IMAGE ?? DEFAULT_IMAGE;

const providerCases: Array<{
  Provider: DeploymentProvider;
  image: string;
  enabled: boolean;
}> = [
  {
    Provider: DockerDeployment,
    image: DEFAULT_IMAGE,
    enabled: true,
  },
  {
    Provider: FlyDeployment,
    image: FLY_IMAGE,
    enabled: FLY_IMAGE.trim().length > 0,
  },
];

for (const providerCase of providerCases) {
  const { Provider, image, enabled } = providerCase;
  describe(`${Provider.name} playground`, () => {
    test.skipIf(!RUN_E2E || !enabled || !Provider.implemented)(
      "shows class layout and shared clients",
      async () => {
        await using deployment = await createDeployment(
          Provider,
          {
            image,
          },
          {
            name: `jonasland-playground-${Provider.name.toLowerCase()}`,
          },
        );

        expect(deployment.providerName).toBeTypeOf("string");
        expect(JSON.parse(JSON.stringify(deployment))).toBeTypeOf("object");
        expect(typeof deployment.pidnap.manager.status).toBe("function");
        expect(typeof deployment.registry.routes.list).toBe("function");
        expect(typeof deployment.caddy.getConfig).toBe("function");
        expect(await deployment.providerStatus()).toBe("running");
      },
    );
  });
}
