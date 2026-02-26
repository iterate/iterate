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
const RUN_FLY_E2E = RUN_E2E && E2E_PROVIDER === "fly";

const RUN_FLY_FRP_E2E = RUN_FLY_E2E && process.env.RUN_JONASLAND_FRP_E2E === "true";

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

describe.runIf(RUN_FLY_FRP_E2E)("jonasland fly frp egress", () => {
  test("fly machine POSTs https://example.com via egress+frp and body arrives at local mock", async () => {
    if (image.trim().length === 0) {
      throw new Error("Set JONASLAND_E2E_FLY_IMAGE or FLY_DEFAULT_IMAGE for Fly e2e");
    }

    let step = "setup";
    let curlOutput = "";
    try {
      await using proxy = await mockEgressProxy();
      step = "configure-proxy-handler";
      proxy.fetch = async (request) =>
        Response.json({
          ok: true,
          url: request.url,
          path: new URL(request.url).pathname,
        });

      step = "create-fly-deployment";
      await using deployment = await projectDeployment({
        image,
        name: `jonasland-e2e-fly-frp-${randomUUID().slice(0, 8)}`,
      });

      step = "start-frp-bridge";
      await using frpBridge = await startFlyFrpEgressBridge({
        deployment,
        localTargetPort: proxy.port,
        frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
      });
      await startEgressProxyWithExternalProxy(deployment, frpBridge.dataProxyUrl);

      step = "wait-for-delivery";
      const requestPath = "/vitest-frp-post";
      const payload = JSON.stringify({
        message: "hello-from-fly",
        run: "frp-post-proof",
      });
      const payloadShellQuoted = `'${payload.replaceAll("'", "'\"'\"'")}'`;
      const delivery = proxy.waitFor((request) => request.url.includes(requestPath), {
        timeout: 120_000,
      });

      step = "issue-egress-request";
      const curl = await deployment.exec([
        "sh",
        "-ec",
        [
          "curl -4 -i -sS -k",
          "-H 'content-type: application/json'",
          `--data ${payloadShellQuoted}`,
          `https://example.com${requestPath}`,
        ].join(" "),
      ]);
      curlOutput = curl.output;

      step = "assert-curl-response";
      expect(curl.exitCode).toBe(0);
      if (!curl.output.includes('"ok":true')) {
        const frpsLogs = await deployment
          .exec(["bash", "-lc", "tail -n 200 /tmp/frps-*.frps.log 2>/dev/null || true"])
          .catch(() => ({ exitCode: 1, output: "" }));
        throw new Error(
          `egress curl did not return mock payload:\n${curl.output}\nfrpc logs:\n${frpBridge.clientLogs()}\nfrps logs:\n${frpsLogs.output}`,
        );
      }
      expect(curl.output.toLowerCase()).toContain("x-iterate-egress-mode: external-proxy");
      expect(curl.output.toLowerCase()).toContain("x-iterate-egress-proxy-seen: 1");

      step = "assert-proxy-delivery";
      const record = await delivery.catch((error) => {
        const observed = proxy.records
          .slice(-10)
          .map((entry) => `${entry.request.method} ${entry.request.url}`)
          .join("\n");
        throw new Error(
          `mock egress did not observe ${requestPath} (records=${String(proxy.records.length)})\ncurl output:\n${curlOutput}\nobserved:\n${observed}`,
          { cause: error },
        );
      });
      expect(new URL(record.request.url).pathname).toBe(requestPath);
      expect(record.request.method).toBe("POST");
      expect(record.request.headers.get("host")).toContain("127.0.0.1:27180");
      expect(record.request.headers.get("x-iterate-egress-mode")).toBe("external-proxy");
      expect(await record.request.text()).toBe(payload);
      expect(record.response.status).toBe(200);
    } catch (error) {
      throw new Error(`fly frp e2e failed during: ${step}`, {
        cause: error,
      });
    }
  }, 900_000);
});
