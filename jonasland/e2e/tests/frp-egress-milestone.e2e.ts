import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { describe, expect, test } from "vitest";
import {
  DockerDeployment,
  FlyDeployment,
  MockEgressProxy,
  startFlyFrpEgressBridge,
  type Deployment,
} from "../test-helpers/index.ts";

type ProviderName = "docker" | "fly";

type ProviderCase = {
  name: ProviderName;
  enabled: boolean;
  create: () => Promise<Deployment>;
};

const providerEnv = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const runAllProviders = providerEnv === "all";

const DOCKER_IMAGE = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland-sandbox:local";
const FLY_IMAGE =
  process.env.JONASLAND_E2E_FLY_IMAGE ??
  process.env.FLY_DEFAULT_IMAGE ??
  process.env.JONASLAND_SANDBOX_IMAGE ??
  "";

const providerCases: ProviderCase[] = [
  {
    name: "docker",
    enabled: runAllProviders || providerEnv === "docker",
    create: async () =>
      await DockerDeployment.withConfig({
        image: DOCKER_IMAGE,
      }).create({
        name: deploymentNameForCurrentTest("docker"),
      }),
  },
  {
    name: "fly",
    enabled: (runAllProviders || providerEnv === "fly") && FLY_IMAGE.trim().length > 0,
    create: async () =>
      await FlyDeployment.withConfig({
        image: FLY_IMAGE,
      }).create({
        name: deploymentNameForCurrentTest("fly"),
      }),
  },
];

function slugifyForName(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 32);
}

function deploymentNameForCurrentTest(provider: ProviderName): string {
  const currentTestName = expect.getState().currentTestName ?? "unnamed-test";
  const workerId = process.env.VITEST_WORKER_ID ?? "0";
  const slug = slugifyForName(currentTestName);
  return `jonasland-vtest-${provider}-${workerId}-${slug}`;
}

async function postEventsOrpc(
  deployment: Deployment,
  procedure: string,
  body: unknown,
): Promise<{ exitCode: number; output: string }> {
  return await deployment.exec([
    "curl",
    "-fsS",
    "-H",
    "Host: events.iterate.localhost",
    "-H",
    "content-type: application/json",
    "--data",
    JSON.stringify({ json: body }),
    `http://127.0.0.1/orpc/${procedure}`,
  ]);
}

async function waitForFirehoseEvent(params: {
  deployment: Deployment;
  matcher: (event: Record<string, unknown>) => boolean;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const ingressUrl = new URL(await params.deployment.ingressUrl());
  const requestUrl = new URL("/api/firehose", ingressUrl);

  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for matching firehose event"));
    }, timeoutMs);

    let buffer = "";
    let settled = false;
    const request = httpRequest(
      {
        protocol: requestUrl.protocol,
        hostname: requestUrl.hostname,
        port: requestUrl.port,
        path: `${requestUrl.pathname}${requestUrl.search}`,
        method: "GET",
        headers: {
          host: "events.iterate.localhost",
          accept: "text/event-stream",
        },
      },
      (response) => {
        if ((response.statusCode ?? 500) >= 400) {
          cleanup();
          reject(new Error(`firehose request failed with status ${String(response.statusCode)}`));
          return;
        }

        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffer += chunk;
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const lines = frame
              .split("\n")
              .map((line) => line.trimEnd())
              .filter((line) => line.length > 0);
            const eventType = lines.find((line) => line.startsWith("event: "))?.slice(7);
            if (eventType !== undefined && eventType !== "message") continue;

            const dataLine = lines.find((line) => line.startsWith("data: "));
            if (!dataLine) continue;

            const event = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
            if (!params.matcher(event)) continue;

            cleanup();
            resolve(event);
            return;
          }
        });

        response.on("error", (error) => {
          cleanup();
          reject(error);
        });
      },
    );

    request.on("error", (error) => {
      cleanup();
      reject(error);
    });
    request.end();

    function cleanup() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.destroy();
    }
  });
}

for (const provider of providerCases) {
  // Tip: run a single provider with `pnpm jonasland e2e -t docker` or `-t fly`.
  describe.runIf(provider.enabled)(`frp egress milestone (${provider.name})`, () => {
    test("routes external-proxy egress via frp to local mock", async () => {
      await using proxy = await MockEgressProxy.create();

      await using deployment = await provider.create();

      await using frpBridge = await startFlyFrpEgressBridge({
        deployment,
        localTargetPort: proxy.port,
        frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
      });

      const egressProcess = await deployment.pidnap.processes.get({
        target: "egress-proxy",
        includeEffectiveEnv: false,
      });
      await deployment.pidnap.processes.updateConfig({
        processSlug: "egress-proxy",
        definition: {
          ...egressProcess.definition,
          env: {
            ...(egressProcess.definition.env ?? {}),
            ITERATE_EXTERNAL_EGRESS_PROXY: frpBridge.dataProxyUrl,
          },
        },
        options: {
          restartPolicy: "always",
        },
        restartImmediately: true,
      });
      await deployment.pidnap.processes.start({ target: "egress-proxy" }).catch(() => {});
      await deployment.waitForPidnapProcessRunning({ target: "egress-proxy" });

      const requestPath = "/vitest-frp-milestone";
      const payload = JSON.stringify({
        source: `${provider.name}-frp-milestone`,
      });
      const observed = proxy.waitFor((request) => new URL(request.url).pathname === requestPath);
      proxy.fetch = async (request) =>
        Response.json({
          ok: true,
          path: new URL(request.url).pathname,
          mode: "external-proxy",
        });

      const curl = await deployment.exec([
        "curl",
        "-4",
        "-k",
        "-sS",
        "-i",
        "-H",
        "content-type: application/json",
        "--data",
        payload,
        `https://api.openai.com${requestPath}`,
      ]);

      expect(curl.exitCode).toBe(0);
      expect(curl.output).toContain('"ok":true');
      expect(curl.output.toLowerCase()).toContain("x-iterate-egress-mode: external-proxy");
      expect(curl.output.toLowerCase()).toContain("x-iterate-egress-proxy-seen: 1");

      // Slightly clunky for now: register mock observation before the request
      // to avoid even theoretical race windows.
      const { request, response } = await observed;
      expect(new URL(request.url).pathname).toBe(requestPath);
      expect(await request.text()).toBe(payload);
      expect(request.headers.get("host")).toContain("127.0.0.1:27180");
      expect(response.status).toBe(200);
    }, 900_000);

    test("events firehose SSE emits appended event", async () => {
      await using deployment = await provider.create();

      const streamPath = `frp-milestone/events/${randomUUID().slice(0, 8)}`;
      const expectedType = "https://events.iterate.com/events/test/frp-milestone-sse";
      const expectedPayload = {
        source: `${provider.name}-firehose`,
        run: randomUUID().slice(0, 8),
      };

      const observed = waitForFirehoseEvent({
        deployment,
        timeoutMs: 120_000,
        matcher: (event) => {
          const eventPath = String(event["path"] ?? "").replace(/^\/+/, "");
          return eventPath === streamPath && String(event["type"] ?? "") === expectedType;
        },
      });
      observed.catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 100));

      const appendResult = await postEventsOrpc(deployment, "append", {
        path: streamPath,
        events: [
          {
            type: expectedType,
            payload: expectedPayload,
          },
        ],
      });
      expect(appendResult.exitCode).toBe(0);
      expect(appendResult.output).toBe("{}");

      const event = await observed;
      expect(String(event["path"])).toBe(streamPath);
      expect(String(event["type"])).toBe(expectedType);
      expect(event["payload"]).toEqual(expectedPayload);
    }, 900_000);
  });
}
