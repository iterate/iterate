import { beforeEach, describe, expect, test, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  parseDeploymentConfig: vi.fn(),
  parseDeploymentLocator: vi.fn(),
  deploymentConnect: vi.fn(),
}));

vi.mock("./deployment-provider-factory.ts", () => ({
  parseDeploymentConfig: mocked.parseDeploymentConfig,
  parseDeploymentLocator: mocked.parseDeploymentLocator,
}));

vi.mock("@iterate-com/shared/jonasland/deployment/deployment.ts", () => ({
  Deployment: Object.assign(
    vi.fn(() => makeRuntime()),
    {
      connect: mocked.deploymentConnect,
    },
  ),
}));

import { DeploymentRuntimeRegistry } from "./deployment-runtime-registry.ts";

function makeRuntime() {
  return {
    snapshot: vi.fn(() => ({ state: "new" as const })),
  };
}

describe("DeploymentRuntimeRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.deploymentConnect.mockResolvedValue(makeRuntime());
  });

  test("hydrateFromRow reconnects an existing persisted locator", async () => {
    mocked.parseDeploymentConfig.mockReturnValue({
      provider: {},
      opts: { image: "sandbox:test" },
    });
    mocked.parseDeploymentLocator.mockReturnValue({
      provider: "docker",
      containerId: "ctr_123",
      containerName: "demo",
    });

    const registry = new DeploymentRuntimeRegistry(() => []);
    await registry.hydrateFromRow({
      id: "dpl_123",
      provider: "docker",
      slug: "demo",
      opts: { providerOpts: {}, opts: { image: "sandbox:test" } },
      deploymentLocator: {
        provider: "docker",
        containerId: "ctr_123",
        containerName: "demo",
      },
      createdAt: new Date(),
    });

    expect(mocked.deploymentConnect).toHaveBeenCalledWith({
      provider: {},
      locator: {
        provider: "docker",
        containerId: "ctr_123",
        containerName: "demo",
      },
    });
  });

  test("hydrateFromRow returns null when there is no saved locator", async () => {
    mocked.parseDeploymentConfig.mockReturnValue({
      provider: {},
      opts: { image: "sandbox:test" },
    });

    const registry = new DeploymentRuntimeRegistry(() => []);
    const runtime = await registry.hydrateFromRow({
      id: "dpl_123",
      provider: "docker",
      slug: "demo",
      opts: { providerOpts: {}, opts: { image: "sandbox:test" } },
      deploymentLocator: null,
      createdAt: new Date(),
    });

    expect(runtime).toBeNull();
    expect(mocked.deploymentConnect).not.toHaveBeenCalled();
  });
});
