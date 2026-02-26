import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  mockEgressProxy,
  projectDeployment,
  startFlyFrpEgressBridge,
  type ProjectDeployment,
} from "../test-helpers/index.ts";

const RUN_E2E = process.env.RUN_JONASLAND_E2E === "true";
const E2E_PROVIDER = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const RUN_DOCKER_E2E = RUN_E2E && E2E_PROVIDER === "docker";
const RUN_DOCKER_FRP_E2E = RUN_DOCKER_E2E && process.env.RUN_JONASLAND_FRP_E2E === "true";
const image = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland-sandbox:local";

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

async function startEgressProxyWithExternalProxy(
  deployment: ProjectDeployment,
  externalProxyUrl: string,
): Promise<void> {
  const updated = await deployment.pidnap.processes.updateConfig({
    processSlug: "egress-proxy",
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/egress-service/src/server.ts"],
      env: {
        ...OTEL_SERVICE_ENV,
        ITERATE_EXTERNAL_EGRESS_PROXY: externalProxyUrl,
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
    timeoutMs: 45_000,
  });

  await waitForDirectHttp(deployment, {
    url: "http://127.0.0.1:19000/healthz",
  });
}

describe.runIf(RUN_DOCKER_FRP_E2E)("jonasland docker frp egress", () => {
  test("https://example.com egresses via frp tunnel to vitest mock", async () => {
    await using proxy = await mockEgressProxy();
    proxy.fetch = async (request) =>
      Response.json({
        ok: true,
        url: request.url,
        path: new URL(request.url).pathname,
        method: request.method,
      });

    await using deployment = await projectDeployment({
      image,
      name: `jonasland-e2e-docker-frp-${randomUUID().slice(0, 8)}`,
    });

    await using frpBridge = await startFlyFrpEgressBridge({
      deployment,
      localTargetPort: proxy.port,
      frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
    });

    await startEgressProxyWithExternalProxy(deployment, frpBridge.dataProxyUrl);

    const requestPath = "/vitest-frp-post";
    const payload = JSON.stringify({
      source: "docker-frp-e2e",
      run: randomUUID().slice(0, 8),
    });
    const payloadShellQuoted = `'${payload.replaceAll("'", "'\"'\"'")}'`;
    const observed = proxy.waitFor((request) => new URL(request.url).pathname === requestPath, {
      timeout: 120_000,
    });

    const curl = await deployment.exec([
      "sh",
      "-ec",
      [
        "curl -4 -k -sS -i",
        "-H 'content-type: application/json'",
        `--data ${payloadShellQuoted}`,
        `https://example.com${requestPath}`,
      ].join(" "),
    ]);

    expect(curl.exitCode).toBe(0);
    expect(curl.output).toContain('"ok":true');
    expect(curl.output.toLowerCase()).toContain("x-iterate-egress-mode: external-proxy");
    expect(curl.output.toLowerCase()).toContain("x-iterate-egress-proxy-seen: 1");

    const delivered = await observed.catch(async (error) => {
      const frpsLogs = await deployment
        .exec(["bash", "-lc", "tail -n 200 /tmp/frps-*.frps.log 2>/dev/null || true"])
        .catch(() => ({ exitCode: 1, output: "" }));
      throw new Error(
        `mock egress did not observe ${requestPath}\ncurl output:\n${curl.output}\nfrpc logs:\n${frpBridge.clientLogs()}\nfrps logs:\n${frpsLogs.output}`,
        { cause: error },
      );
    });

    expect(new URL(delivered.request.url).pathname).toBe(requestPath);
    expect(delivered.request.method).toBe("POST");
    expect(await delivered.request.text()).toBe(payload);
    expect(delivered.request.headers.get("host")).toContain("127.0.0.1:27180");
    expect(delivered.request.headers.get("x-iterate-egress-mode")).toBe("external-proxy");
    expect(delivered.response.status).toBe(200);
  }, 300_000);
});
