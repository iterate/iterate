import { describe, expect, test as baseTest } from "vitest";
import { createMockIterateOsApi } from "./mock-iterate-os-api/server.ts";
import { startCloudflaredTunnel } from "./helpers/cloudflared.ts";
import { dumpLogsOnFailure } from "./helpers/log-dumper.ts";
import { getProvider } from "./providers/index.ts";
import type { MockIterateOsApi } from "./mock-iterate-os-api/types.ts";
import type { SandboxHandle, SandboxProvider } from "./providers/types.ts";

interface LocalFixtures {
  provider: SandboxProvider;
  sandbox: SandboxHandle;
}

interface IntegrationFixtures extends LocalFixtures {
  mock: MockIterateOsApi;
  mockUrl: string;
}

export const localTest = baseTest.extend<LocalFixtures>({
  provider: async (_ctx, use) => {
    await use(getProvider());
  },
  sandbox: async ({ provider, task }, use) => {
    const sandbox = await provider.createSandbox();
    try {
      await sandbox.waitForServiceHealthy("iterate-daemon");
      await use(sandbox);
    } finally {
      if (task.result?.state === "fail") {
        await dumpLogsOnFailure({ sandbox });
      }
      await sandbox.delete();
    }
  },
});

export const integrationTest = baseTest.extend<IntegrationFixtures>({
  provider: async (_ctx, use) => {
    await use(getProvider());
  },
  mock: async (_ctx, use) => {
    const mock = createMockIterateOsApi();
    await mock.start();
    await use(mock);
    await mock.close();
  },
  mockUrl: async ({ provider, mock }, use) => {
    if (provider.name === "local-docker") {
      await use(`http://host.docker.internal:${mock.port}`);
      return;
    }
    const tunnel = await startCloudflaredTunnel(mock.port);
    try {
      await use(tunnel.url);
    } finally {
      tunnel.close();
    }
  },
  sandbox: async ({ provider, mockUrl, mock, task }, use) => {
    const sandbox = await provider.createSandbox({
      env: {
        ITERATE_OS_BASE_URL: mockUrl,
        ITERATE_OS_API_KEY: "test-key",
        ITERATE_EGRESS_PROXY_URL: `${mockUrl}/api/egress-proxy`,
        ITERATE_MACHINE_ID: `test-${Date.now()}`,
      },
    });
    try {
      await sandbox.waitForServiceHealthy("iterate-daemon");
      await use(sandbox);
    } finally {
      if (task.result?.state === "fail") {
        await dumpLogsOnFailure({ sandbox, mock });
      }
      await sandbox.delete();
    }
  },
});

export { describe, expect };
