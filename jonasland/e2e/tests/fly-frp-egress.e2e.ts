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

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;

  const direct =
    "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? ((error as { code: string }).code ?? undefined)
      : undefined;
  if (direct) return direct;

  const cause =
    "cause" in error && (error as { cause?: unknown }).cause
      ? (error as { cause: unknown }).cause
      : undefined;
  if (!cause || cause === error) return undefined;
  return errorCode(cause);
}

function isRetriableSocketError(error: unknown): boolean {
  const code = errorCode(error);
  if (!code) return false;
  return (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  );
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function withRetriableSocketErrors<T>(task: () => Promise<T>): Promise<T> {
  const maxAttempts = 8;
  let attempt = 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= maxAttempts || !isRetriableSocketError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(250 * attempt, 1_500)));
      attempt += 1;
    }
  }
}

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
  await withRetriableSocketErrors(async () => {
    const definition = JSON.stringify({
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/egress-service/src/server.ts"],
      env: {
        ...OTEL_SERVICE_ENV,
        ITERATE_EXTERNAL_EGRESS_PROXY: params.externalProxyUrl,
      },
    });
    const reloaded = await deployment.exec([
      "bash",
      "-lc",
      `/opt/pidnap/node_modules/.bin/tsx /opt/pidnap/src/cli.ts process reload egress-proxy -d ${shellSingleQuote(definition)} -r true`,
    ]);
    if (reloaded.exitCode !== 0) {
      throw new Error(`failed to reload egress-proxy:\n${reloaded.output}`);
    }
    await waitForDirectHttp(deployment, {
      url: "http://127.0.0.1:19000/healthz",
    });
  });
}

describe.runIf(RUN_FLY_FRP_E2E)("jonasland fly frp egress", () => {
  test("fly machine reaches host-local mock egress over direct frp tunnel", async () => {
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

      step = "wait-for-delivery";
      const delivery = proxy.waitFor((request) => request.url.includes("/v1/models"), {
        timeout: 120_000,
      });

      step = "issue-egress-request";
      const curl = await deployment.exec([
        "sh",
        "-ec",
        `curl -i -sS -H 'Host: api.openai.com' ${frpBridge.dataProxyUrl}/v1/models`,
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

      step = "assert-proxy-delivery";
      const record = await delivery.catch((error) => {
        const observed = proxy.records
          .slice(-10)
          .map((entry) => `${entry.request.method} ${entry.request.url}`)
          .join("\n");
        throw new Error(
          `mock egress did not observe /v1/models (records=${String(proxy.records.length)})\ncurl output:\n${curlOutput}\nobserved:\n${observed}`,
          { cause: error },
        );
      });
      expect(new URL(record.request.url).pathname).toBe("/v1/models");
      expect(record.response.status).toBe(200);
    } catch (error) {
      throw new Error(`fly frp e2e failed during: ${step}`, {
        cause: error,
      });
    }
  }, 900_000);
});
