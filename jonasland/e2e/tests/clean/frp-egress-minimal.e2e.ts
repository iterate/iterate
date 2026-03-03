import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { FlyDeployment } from "@iterate-com/shared/jonasland/deployment";
import { startFlyFrpEgressBridge } from "../../test-helpers/frp-egress-bridge.ts";
import { mockEgressProxy } from "../../test-helpers/mock-egress-proxy.ts";

const FLY_IMAGE = process.env.JONASLAND_E2E_FLY_IMAGE ?? "";
const providerEnv = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const runAllProviders = providerEnv === "all";
const runFly = (runAllProviders || providerEnv === "fly") && FLY_IMAGE.trim().length > 0;

function slugifyForName(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 32);
}

function deploymentNameForCurrentTest(): string {
  const currentTestName = expect.getState().currentTestName ?? "unnamed-test";
  const workerId = process.env.VITEST_WORKER_ID ?? "0";
  const slug = slugifyForName(currentTestName);
  const nonce = randomUUID().slice(0, 8);
  return `jonasland-vitest-fly-${workerId}-${slug}-${nonce}`;
}

describe.runIf(runFly)("clean frp egress minimal (fly)", () => {
  test("curl from deployment reaches outside mock through frp egress", async () => {
    await using outsideMock = await mockEgressProxy();
    await using deployment = await FlyDeployment.createWithConfig({
      flyImage: FLY_IMAGE,
    }).create({
      name: deploymentNameForCurrentTest(),
    });

    const requestPath = `/vitest-frp-minimal/${randomUUID().slice(0, 8)}`;
    const requestBody = JSON.stringify({ ok: true, via: "frp-egress-minimal" });

    outsideMock.fetch = async (request) =>
      Response.json({
        ok: true,
        path: new URL(request.url).pathname,
        echoedBody: await request.clone().text(),
      });

    const observed = outsideMock.waitFor(
      (request) => new URL(request.url).pathname === requestPath,
      { timeout: 180_000 },
    );
    observed.catch(() => {});

    await using tunnel = await startFlyFrpEgressBridge({
      deployment,
      localTargetPort: outsideMock.port,
      frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
    });

    await deployment.useEgressProxy({ proxyUrl: tunnel.dataProxyUrl });

    const curl = await deployment.exec([
      "curl",
      "-4",
      "-sS",
      "-i",
      "--connect-timeout",
      "10",
      "--max-time",
      "30",
      "-H",
      "content-type: application/json",
      "--data",
      requestBody,
      `http://example.com${requestPath}`,
    ]);

    expect(curl.exitCode).toBe(0);
    expect(curl.output).toContain('"ok":true');
    expect(curl.output.toLowerCase()).toContain("x-iterate-egress-mode: external-proxy");

    const observedRecord = await observed;
    expect(new URL(observedRecord.request.url).pathname).toBe(requestPath);
    expect(await observedRecord.request.text()).toBe(requestBody);
    expect(observedRecord.request.headers.get("host")).toContain("127.0.0.1:27180");
    expect(observedRecord.request.headers.get("x-forwarded-host")).toBeTruthy();
    expect(observedRecord.request.headers.get("x-forwarded-proto")).toBeTruthy();
    expect(observedRecord.response.status).toBe(200);
  }, 300_000);
});
