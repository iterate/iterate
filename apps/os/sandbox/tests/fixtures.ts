import { describe, expect, test as baseTest } from "vitest";
import { createMockIterateOsApi } from "./mock-iterate-os-api/server.ts";
import { startCloudflaredTunnel } from "./helpers/cloudflared.ts";
import { dumpLogsOnFailure } from "./helpers/log-dumper.ts";
import { getProvider } from "./providers/index.ts";
import type { MockIterateOsApi } from "./mock-iterate-os-api/types.ts";
import type { SandboxHandle, SandboxProvider } from "./providers/types.ts";

type Awaitable<T> = T | Promise<T>;

interface LocalFixtures {
  provider: SandboxProvider;
  sandbox: SandboxHandle;
}

interface IntegrationFixtures extends LocalFixtures {
  mock: MockIterateOsApi;
  mockUrl: string;
}

const hasProvider =
  process.env.RUN_LOCAL_DOCKER_TESTS === "true" || process.env.RUN_DAYTONA_TESTS === "true";
const providerTest = hasProvider ? baseTest : baseTest.skip;

type LocalTestFn = (
  name: string,
  fn: (ctx: LocalFixtures) => Awaitable<void>,
  timeout?: number,
) => void;

type IntegrationTestFn = (
  name: string,
  fn: (ctx: IntegrationFixtures) => Awaitable<void>,
  timeout?: number,
) => void;

export const localTest: LocalTestFn = (name, fn, timeout) => {
  providerTest(
    name,
    async () => {
      const provider = getProvider();
      const sandbox = await provider.createSandbox();
      try {
        await sandbox.waitForServiceHealthy("daemon-backend");
        await fn({ provider, sandbox });
      } catch (error) {
        await dumpLogsOnFailure({ sandbox });
        throw error;
      } finally {
        await sandbox.delete();
      }
    },
    timeout,
  );
};

export const integrationTest: IntegrationTestFn = (name, fn, timeout) => {
  providerTest(
    name,
    async () => {
      const provider = getProvider();
      const mock = createMockIterateOsApi();
      await mock.start();

      let mockUrl = "";
      let closeTunnel: (() => void) | undefined;
      if (provider.name === "local-docker") {
        mockUrl = `http://host.docker.internal:${mock.port}`;
      } else {
        const tunnel = await startCloudflaredTunnel(mock.port);
        mockUrl = tunnel.url;
        closeTunnel = () => tunnel.close();
      }

      const sandbox = await provider.createSandbox({
        env: {
          ITERATE_OS_BASE_URL: mockUrl,
          ITERATE_OS_API_KEY: "test-key",
          ITERATE_EGRESS_PROXY_URL: `${mockUrl}/api/egress-proxy`,
          ITERATE_MACHINE_ID: `test-${Date.now()}`,
        },
      });

      try {
        await sandbox.waitForServiceHealthy("daemon-backend");
        await fn({ provider, mock, mockUrl, sandbox });
      } catch (error) {
        await dumpLogsOnFailure({ sandbox, mock });
        throw error;
      } finally {
        await sandbox.delete();
        closeTunnel?.();
        await mock.close();
      }
    },
    timeout,
  );
};

export { describe, expect };
