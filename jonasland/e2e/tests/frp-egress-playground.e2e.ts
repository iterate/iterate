import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  dockerProjectDeployment,
  flyProjectDeployment,
  mockEgressProxy,
  startFlyFrpEgressBridge,
  type ProjectDeployment,
} from "../test-helpers/index.ts";

type ProviderName = "docker" | "fly";

type ProviderCase = {
  name: ProviderName;
  enabled: boolean;
  image: string;
  create: (opts: { image: string; name: string }) => Promise<ProjectDeployment>;
};

type EgressMode = "direct" | "external-proxy";

const RUN_E2E = process.env.RUN_JONASLAND_E2E === "true";
const RUN_FRP_E2E = process.env.RUN_JONASLAND_FRP_E2E === "true";
const providerEnv = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const runAllProviders = providerEnv === "all";

const DOCKER_IMAGE = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland-sandbox:local";
const FLY_IMAGE =
  process.env.JONASLAND_E2E_FLY_IMAGE ??
  process.env.FLY_DEFAULT_IMAGE ??
  process.env.JONASLAND_SANDBOX_IMAGE ??
  "";

const EGRESS_PROCESS_ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
  OTEL_PROPAGATORS: "tracecontext,baggage",
};

function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const maybeCode = (error as { code?: string }).code;
  const message = error.message.toLowerCase();
  return (
    maybeCode === "ECONNRESET" ||
    maybeCode === "EPIPE" ||
    maybeCode === "ETIMEDOUT" ||
    message.includes("econnreset") ||
    message.includes("socket hang up") ||
    message.includes("und_err_socket")
  );
}

async function retry<T>(task: () => Promise<T>, attempts: number): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (i === attempts - 1 || !isTransientError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * (i + 1)));
    }
  }
  throw lastError;
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function waitForDirectHttp(
  deployment: ProjectDeployment,
  params: { url: string; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 90_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await deployment
      .exec(["curl", "-fsS", params.url])
      .catch(() => ({ exitCode: 1, output: "" }));
    if (result.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for direct http ${params.url}`);
}

async function postEventsOrpc(
  deployment: ProjectDeployment,
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

abstract class DeploymentFixtureBase implements AsyncDisposable {
  protected deployment: ProjectDeployment | null = null;

  constructor(
    protected readonly providerName: ProviderName,
    protected readonly image: string,
  ) {}

  protected abstract createDeployment(opts: {
    image: string;
    name: string;
  }): Promise<ProjectDeployment>;

  protected requireDeployment(): ProjectDeployment {
    if (!this.deployment) throw new Error("deployment not started");
    return this.deployment;
  }

  async start(): Promise<ProjectDeployment> {
    const deployment = await this.createDeployment({
      image: this.image,
      name: `jonasland-e2e-${this.providerName}-frp-${randomUUID().slice(0, 8)}`,
    });
    this.deployment = deployment;
    await deployment.waitForPidnapHostRoute({ timeoutMs: 120_000 });
    await waitForDirectHttp(deployment, {
      url: "http://127.0.0.1/",
      timeoutMs: 120_000,
    });
    return deployment;
  }

  async execWithRetry(
    cmd: string | string[],
    attempts = 8,
  ): Promise<{ exitCode: number; output: string }> {
    const deployment = this.requireDeployment();
    return await retry(async () => await deployment.exec(cmd), attempts);
  }

  async pidnapRpc(path: string, input: unknown): Promise<unknown> {
    const payload = JSON.stringify({ json: input });
    const result = await this.execWithRetry(
      [
        "curl",
        "-fsS",
        "-X",
        "POST",
        "-H",
        "Host: pidnap.iterate.localhost",
        "-H",
        "content-type: application/json",
        "--data",
        payload,
        `http://127.0.0.1/rpc/${path}`,
      ],
      8,
    );
    return JSON.parse(result.output) as unknown;
  }

  async configureEgressProxy(params: { externalProxyUrl?: string }): Promise<void> {
    const deployment = this.requireDeployment();
    await retry(async () => {
      const env = {
        ...EGRESS_PROCESS_ENV,
        ...(params.externalProxyUrl
          ? { ITERATE_EXTERNAL_EGRESS_PROXY: params.externalProxyUrl }
          : {}),
      };

      await this.pidnapRpc("processes/updateConfig", {
        processSlug: "egress-proxy",
        definition: {
          command: "/opt/pidnap/node_modules/.bin/tsx",
          args: ["/opt/services/egress-service/src/server.ts"],
          env,
        },
        options: { restartPolicy: "always" },
        envOptions: { reloadDelay: false },
        restartImmediately: true,
      });

      await this.execWithRetry(
        [
          "sh",
          "-ec",
          [
            "curl -sS -X POST",
            "-H 'Host: pidnap.iterate.localhost'",
            "-H 'content-type: application/json'",
            '--data \'{"json":{"target":"egress-proxy"}}\'',
            "http://127.0.0.1/rpc/processes/start",
            "|| true",
          ].join(" "),
        ],
        4,
      );

      await this.pidnapRpc("processes/waitForRunning", {
        target: "egress-proxy",
        timeoutMs: 120_000,
        pollIntervalMs: 300,
        includeLogs: true,
        logTailLines: 120,
      });
    }, 8);

    await waitForDirectHttp(deployment, {
      url: "http://127.0.0.1:19000/healthz",
      timeoutMs: 120_000,
    });
  }

  async exec(cmd: string | string[]) {
    return await this.execWithRetry(cmd, 8);
  }

  async runEgressRequestViaCurl(params: {
    requestPath: string;
    payloadJson: string;
    mode: EgressMode;
    directTargetUrl?: string;
  }): Promise<{ exitCode: number; output: string }> {
    const targetHeader =
      params.mode === "direct" ? `-H 'x-iterate-target-url: ${params.directTargetUrl ?? ""}'` : "";
    return await this.exec([
      "sh",
      "-ec",
      [
        "curl -4 -k -sS -i",
        "-H 'content-type: application/json'",
        targetHeader,
        `--data ${shQuote(params.payloadJson)}`,
        `https://api.openai.com${params.requestPath}`,
      ]
        .filter((part) => part.length > 0)
        .join(" "),
    ]);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.deployment) return;
    await this.deployment[Symbol.asyncDispose]();
    this.deployment = null;
  }
}

class DockerFixture extends DeploymentFixtureBase {
  constructor(image: string) {
    super("docker", image);
  }

  protected override async createDeployment(opts: {
    image: string;
    name: string;
  }): Promise<ProjectDeployment> {
    return await dockerProjectDeployment(opts);
  }
}

class FlyFixture extends DeploymentFixtureBase {
  constructor(image: string) {
    super("fly", image);
  }

  protected override async createDeployment(opts: {
    image: string;
    name: string;
  }): Promise<ProjectDeployment> {
    return await flyProjectDeployment(opts);
  }
}

const providerCases: ProviderCase[] = [
  {
    name: "docker",
    enabled: runAllProviders || providerEnv === "docker",
    image: DOCKER_IMAGE,
    create: async ({ image, name }) => await dockerProjectDeployment({ image, name }),
  },
  {
    name: "fly",
    enabled: (runAllProviders || providerEnv === "fly") && FLY_IMAGE.trim().length > 0,
    image: FLY_IMAGE,
    create: async ({ image, name }) => await flyProjectDeployment({ image, name }),
  },
];

function makeFixture(params: { providerName: ProviderName; image: string }): DeploymentFixtureBase {
  return params.providerName === "fly"
    ? new FlyFixture(params.image)
    : new DockerFixture(params.image);
}

for (const provider of providerCases) {
  describe.runIf(RUN_E2E && RUN_FRP_E2E && provider.enabled)(
    `deployment abstraction parity (${provider.name})`,
    () => {
      test("core control plane + events orpc append/list works", async () => {
        await using fixture = makeFixture({
          providerName: provider.name,
          image: provider.image,
        });
        const deployment = await fixture.start();

        const streamPath = `frp-parity/events/${randomUUID().slice(0, 8)}`;
        const appendResult = await retry(
          async () =>
            await postEventsOrpc(deployment, "append", {
              path: streamPath,
              events: [
                {
                  type: "https://events.iterate.com/events/test/e2e-recorded",
                  payload: { ok: true },
                },
              ],
            }),
          6,
        );
        expect(appendResult.exitCode).toBe(0);
        expect(appendResult.output).toBe("{}");

        const listResult = await retry(
          async () => await postEventsOrpc(deployment, "listStreams", {}),
          6,
        );
        expect(listResult.exitCode).toBe(0);
        const parsed = JSON.parse(listResult.output) as {
          json: Array<{ path: string; eventCount: number }>;
        };
        const expectedPath = `/${streamPath}`;
        expect(
          parsed.json.some((entry) => entry.path === expectedPath && entry.eventCount >= 1),
        ).toBe(true);
      }, 900_000);

      test("frp + egress direct mode delivers payload to local vitest mock", async () => {
        await using proxy = await mockEgressProxy();
        proxy.fetch = async (request) =>
          Response.json({
            ok: true,
            path: new URL(request.url).pathname,
            mode: "direct-target",
          });

        await using fixture = makeFixture({
          providerName: provider.name,
          image: provider.image,
        });
        const deployment = await fixture.start();

        await using frpBridge = await startFlyFrpEgressBridge({
          deployment,
          localTargetPort: proxy.port,
          frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
        });

        await fixture.configureEgressProxy({});

        const requestPath = "/vitest-frp-direct";
        const payload = JSON.stringify({
          source: `${provider.name}-frp-direct`,
          run: randomUUID().slice(0, 8),
        });
        const observed = proxy.waitFor((request) => new URL(request.url).pathname === requestPath, {
          timeout: 180_000,
        });

        const directTargetUrl = `${frpBridge.dataProxyUrl}${requestPath}`;
        const curl = await fixture.runEgressRequestViaCurl({
          requestPath: "/ignored-direct-path",
          payloadJson: payload,
          mode: "direct",
          directTargetUrl,
        });

        expect(curl.exitCode).toBe(0);
        expect(curl.output).toContain('"ok":true');
        expect(curl.output.toLowerCase()).toContain("x-iterate-egress-mode: direct");
        expect(curl.output.toLowerCase()).toContain("x-iterate-egress-proxy-seen: 1");

        const delivered = await observed;
        expect(new URL(delivered.request.url).pathname).toBe(requestPath);
        expect(await delivered.request.text()).toBe(payload);
        expect(delivered.response.status).toBe(200);
      }, 900_000);

      test("frp + egress external-proxy mode delivers payload to local vitest mock", async () => {
        await using proxy = await mockEgressProxy();
        proxy.fetch = async (request) =>
          Response.json({
            ok: true,
            path: new URL(request.url).pathname,
            mode: "external-proxy",
          });

        await using fixture = makeFixture({
          providerName: provider.name,
          image: provider.image,
        });
        const deployment = await fixture.start();

        await using frpBridge = await startFlyFrpEgressBridge({
          deployment,
          localTargetPort: proxy.port,
          frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
        });

        await fixture.configureEgressProxy({
          externalProxyUrl: frpBridge.dataProxyUrl,
        });

        const requestPath = "/vitest-frp-external";
        const payload = JSON.stringify({
          source: `${provider.name}-frp-external`,
          run: randomUUID().slice(0, 8),
        });
        const observed = proxy.waitFor((request) => new URL(request.url).pathname === requestPath, {
          timeout: 180_000,
        });

        const curl = await fixture.runEgressRequestViaCurl({
          requestPath,
          payloadJson: payload,
          mode: "external-proxy",
        });

        expect(curl.exitCode).toBe(0);
        expect(curl.output).toContain('"ok":true');
        expect(curl.output.toLowerCase()).toContain("x-iterate-egress-mode: external-proxy");
        expect(curl.output.toLowerCase()).toContain("x-iterate-egress-proxy-seen: 1");

        const delivered = await observed;
        expect(new URL(delivered.request.url).pathname).toBe(requestPath);
        expect(await delivered.request.text()).toBe(payload);
        expect(delivered.request.headers.get("host")).toContain("127.0.0.1:27180");
        expect(delivered.response.status).toBe(200);
      }, 900_000);
    },
  );
}
