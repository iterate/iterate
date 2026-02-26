import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  createCfProxyWorkerClient,
  mockEgressProxy,
  projectDeployment,
  startFlyFrpEgressBridge,
  type ProjectDeployment,
} from "../test-helpers/index.ts";

const RUN_E2E = process.env.RUN_JONASLAND_E2E === "true";
const E2E_PROVIDER = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const RUN_FLY_E2E = RUN_E2E && E2E_PROVIDER === "fly";

const CF_PROXY_WORKER_BASE_URL = (process.env.JONASLAND_E2E_CF_PROXY_WORKER_BASE_URL ?? "").trim();
const CF_PROXY_WORKER_API_TOKEN = (
  process.env.JONASLAND_E2E_CF_PROXY_WORKER_API_TOKEN ?? ""
).trim();
const CF_PROXY_WORKER_ROUTE_DOMAIN = (
  process.env.JONASLAND_E2E_CF_PROXY_WORKER_ROUTE_DOMAIN ?? ""
).trim();

const RUN_FLY_FRP_E2E =
  RUN_FLY_E2E &&
  CF_PROXY_WORKER_BASE_URL.length > 0 &&
  CF_PROXY_WORKER_API_TOKEN.length > 0 &&
  CF_PROXY_WORKER_ROUTE_DOMAIN.length > 0 &&
  process.env.RUN_JONASLAND_FRP_E2E === "true";

const image =
  process.env.JONASLAND_E2E_FLY_IMAGE ??
  process.env.FLY_DEFAULT_IMAGE ??
  process.env.JONASLAND_SANDBOX_IMAGE ??
  "";

const OTEL_SERVICE_ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
  OTEL_PROPAGATORS: "tracecontext,baggage",
};

async function waitForDirectHttp(
  deployment: ProjectDeployment,
  params: { url: string; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await deployment
      .exec(["curl", "-fsS", params.url])
      .catch(() => ({ exitCode: 1, output: "" }));
    if (result.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for direct http ${params.url}`);
}

async function startEgressProxyProcess(
  deployment: ProjectDeployment,
  params: { externalProxyUrl: string },
): Promise<void> {
  const updated = await deployment.pidnap.processes.updateConfig({
    processSlug: "egress-proxy",
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/egress-service/src/server.ts"],
      env: {
        ...OTEL_SERVICE_ENV,
        ITERATE_EXTERNAL_EGRESS_PROXY: params.externalProxyUrl,
      },
    },
    options: { restartPolicy: "always" },
    envOptions: { reloadDelay: false },
  });
  if (updated.state !== "running") {
    await deployment.pidnap.processes.start({ target: "egress-proxy" });
  }
  await deployment.waitForPidnapProcessRunning({
    target: "egress-proxy",
    timeoutMs: 60_000,
  });
  await waitForDirectHttp(deployment, {
    url: "http://127.0.0.1:19000/healthz",
  });
}

describe.runIf(RUN_FLY_FRP_E2E)("jonasland fly frp egress", () => {
  test("fly machine reaches host-local mock egress over frp + cf worker route", async () => {
    if (image.trim().length === 0) {
      throw new Error("Set JONASLAND_E2E_FLY_IMAGE or FLY_DEFAULT_IMAGE for Fly e2e");
    }

    await using proxy = await mockEgressProxy();
    proxy.fetch = async (request) =>
      Response.json({
        ok: true,
        url: request.url,
        path: new URL(request.url).pathname,
      });

    const cfProxyWorker = createCfProxyWorkerClient({
      baseUrl: CF_PROXY_WORKER_BASE_URL,
      token: CF_PROXY_WORKER_API_TOKEN,
    });

    await using deployment = await projectDeployment({
      image,
      name: `jonasland-e2e-fly-frp-${randomUUID().slice(0, 8)}`,
    });

    await using frpBridge = await startFlyFrpEgressBridge({
      deployment,
      cfProxyWorkerClient: cfProxyWorker,
      cfProxyWorkerRouteDomain: CF_PROXY_WORKER_ROUTE_DOMAIN,
      localTargetPort: proxy.port,
      frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
    });

    await startEgressProxyProcess(deployment, {
      externalProxyUrl: frpBridge.dataProxyUrl,
    });

    const delivery = proxy.waitFor((request) => new URL(request.url).pathname === "/v1/models", {
      timeout: 120_000,
    });

    const curl = await deployment.exec([
      "sh",
      "-ec",
      "curl -i -sS -H 'Host: api.openai.com' http://127.0.0.1/v1/models",
    ]);

    expect(curl.exitCode).toBe(0);
    expect(curl.output.toLowerCase()).toContain("x-iterate-egress-mode: external-proxy");
    expect(curl.output.toLowerCase()).toContain("x-iterate-egress-proxy-seen: 1");

    const record = await delivery;
    expect(record.request.headers.get("x-iterate-egress-mode")).toBe("external-proxy");
    expect(new URL(record.request.url).pathname).toBe("/v1/models");
    expect(record.response.status).toBe(200);
  }, 900_000);
});
