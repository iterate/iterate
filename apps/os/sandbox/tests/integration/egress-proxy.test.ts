import { integrationTest as test, describe, expect } from "../fixtures.ts";
import { refreshEnv } from "../helpers/refresh-env.ts";

describe("Egress Proxy", () => {
  test("mitmproxy installed and addon exists", async ({ sandbox }) => {
    const version = await sandbox.exec(["mitmproxy", "--version"]);
    expect(version.toLowerCase()).toContain("mitmproxy");

    const addon = await sandbox.exec([
      "cat",
      "/home/iterate/src/github.com/iterate/iterate/apps/os/sandbox/egress-proxy-addon.py",
    ]);
    expect(addon).toContain("def request");
  });

  test("resolves magic strings via egress proxy", async ({ sandbox, mock, mockUrl }) => {
    mock.orpc.setGetEnvResponse({
      envVars: {
        ITERATE_EGRESS_PROXY_URL: `${mockUrl}/api/egress-proxy`,
        ITERATE_OS_API_KEY: "test-key",
        OPENAI_API_KEY: "getIterateSecret({secretKey: 'openai_api_key'})",
      },
      repos: [],
    });
    mock.egress.setSecrets({ openai_api_key: "sk-test-resolved-key" });

    await refreshEnv(sandbox);
    await sandbox.waitForServiceHealthy("egress-proxy", 30_000);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const output = await sandbox.exec([
      "bash",
      "-c",
      'source ~/.iterate/.env && HTTPS_PROXY=http://127.0.0.1:8888 curl -sk --max-time 10 -H "Authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/models',
    ]);
    expect(output).toContain("ok");

    const egressCalls = mock.egress.getRequests(/openai/);
    expect(egressCalls.length).toBeGreaterThan(0);
    expect(egressCalls[0]?.headers.authorization ?? "").toContain("sk-test-resolved-key");

    const secretCalls = mock.egress.getRequests("/api/egress/resolve-secret");
    expect(secretCalls.length).toBeGreaterThan(0);
  });

  test("logs all egress traffic", async ({ sandbox, mock, mockUrl }) => {
    mock.orpc.setGetEnvResponse({
      envVars: {
        ITERATE_EGRESS_PROXY_URL: `${mockUrl}/api/egress-proxy`,
        ITERATE_OS_API_KEY: "test-key",
      },
      repos: [],
    });
    await refreshEnv(sandbox);
    await sandbox.waitForServiceHealthy("egress-proxy", 30_000);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await sandbox.exec([
      "bash",
      "-c",
      "HTTPS_PROXY=http://127.0.0.1:8888 curl -sk --max-time 10 https://httpbin.org/get",
    ]);

    const allEgress = mock.egress.getRequests();
    expect(allEgress.length).toBeGreaterThan(0);
  });
});
