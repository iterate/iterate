import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, test } from "vitest";
import { FlyDeployment } from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";
import { startFrpEgressBridge } from "../../test-helpers/old/frp-egress-bridge.ts";

const FLY_IMAGE = process.env.E2E_FLY_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const FLY_API_TOKEN = process.env.FLY_API_TOKEN ?? "";
const runFly =
  process.env.JONASLAND_E2E_ENABLE_FLY === "true" &&
  FLY_IMAGE.length > 0 &&
  FLY_API_TOKEN.length > 0;

type ObservedRequest = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

async function withOutsideServer<T>(
  handler: (params: {
    port: number;
    waitForRequest: (timeoutMs: number) => Promise<ObservedRequest>;
  }) => Promise<T>,
): Promise<T> {
  let observedResolve: ((request: ObservedRequest) => void) | undefined;
  const observedPromise = new Promise<ObservedRequest>((resolve) => {
    observedResolve = resolve;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const request: ObservedRequest = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      observedResolve?.(request);
      res.writeHead(200, {
        "content-type": "application/json",
        "x-test-outside-server": "1",
      });
      res.end(JSON.stringify({ ok: true, path: request.path }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("outside server has no numeric port");
    }

    const waitForRequest = async (timeoutMs: number): Promise<ObservedRequest> =>
      await Promise.race([
        observedPromise,
        new Promise<ObservedRequest>((_, reject) => {
          setTimeout(() => reject(new Error("timed out waiting for outside request")), timeoutMs);
        }),
      ]);

    return await handler({ port: address.port, waitForRequest });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

describe.runIf(runFly)("frp tunnel", () => {
  test("frpc connects to deployment and deployment curl reaches local test server", async () => {
    await withOutsideServer(async ({ port, waitForRequest }) => {
      await using deployment = await FlyDeployment.create({
        flyImage: FLY_IMAGE,
        flyApiToken: FLY_API_TOKEN,
        name: `e2e-frp-tunnel-${randomUUID().slice(0, 8)}`,
      });

      await deployment.waitUntilAlive({ signal: AbortSignal.timeout(180_000) });

      await using bridge = await startFrpEgressBridge({
        deployment,
        localTargetHost: "127.0.0.1",
        localTargetPort: port,
        frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
      });

      await deployment.setEnvVars({
        ITERATE_EXTERNAL_EGRESS_PROXY: bridge.dataProxyUrl,
      });
      await deployment.pidnap.processes.updateConfig({
        processSlug: "egress-proxy",
        definition: {
          command:
            "/home/iterate/src/github.com/iterate/iterate/packages/pidnap/node_modules/.bin/tsx",
          args: [
            "/home/iterate/src/github.com/iterate/iterate/services/egress-service/src/server.ts",
          ],
          env: {
            EGRESS_PROXY_PORT: "19000",
          },
        },
        options: { restartPolicy: "always" },
        envOptions: { reloadDelay: 500 },
        healthCheck: {
          url: "http://127.0.0.1:19000/__iterate/health",
          intervalMs: 2_000,
        },
      });
      const egressRuntime = await deployment.exec([
        "sh",
        "-lc",
        'for i in $(seq 1 30); do out=$(curl -fsS http://127.0.0.1:19000/api/runtime 2>/dev/null || true); echo "$out" | grep -q \'"externalProxyConfigured":true\' && { echo "$out"; exit 0; }; sleep 1; done; exit 1',
      ]);
      expect(egressRuntime.exitCode, egressRuntime.output).toBe(0);

      const path = `/frp-tunnel/${randomUUID().slice(0, 8)}`;
      const body = JSON.stringify({ from: "deployment-curl", via: "frp-tunnel" });

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
        body,
        `http://example.com${path}`,
      ]);

      expect(curl.exitCode, curl.output).toBe(0);
      expect(curl.output).toContain('"ok":true');
      expect(curl.output.toLowerCase()).toContain("x-iterate-egress-mode: external-proxy");
      expect(curl.output.toLowerCase()).toContain("x-test-outside-server: 1");

      const observed = await waitForRequest(120_000);
      expect(observed.path).toBe(path);
      expect(observed.body).toBe(body);
      expect(String(observed.headers["x-iterate-egress-mode"] ?? "")).toContain("external-proxy");
    });
  }, 420_000);
});
