import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  dockerProjectDeployment,
  flyProjectDeployment,
  mockEgressProxy,
  startFlyFrpEgressBridge,
  type ProjectDeployment,
} from "../test-helpers/index.ts";

type DeploymentOpts = {
  image: string;
  name: string;
};

type ProviderName = "docker" | "fly";

const RUN_E2E = process.env.RUN_JONASLAND_E2E === "true";
const RUN_FRP_E2E = process.env.RUN_JONASLAND_FRP_E2E === "true";
const E2E_PROVIDER = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
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
  const code = (error as { code?: string }).code;
  return code === "ECONNRESET" || code === "EPIPE" || code === "ETIMEDOUT";
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

async function waitForDirectHttp(
  deployment: ProjectDeployment,
  params: { url: string; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 60_000;
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

abstract class FrpDeploymentBase implements AsyncDisposable {
  static readonly implemented: boolean = false;
  static readonly providerName: ProviderName = "docker";

  protected deployment: ProjectDeployment | null = null;

  constructor(protected readonly opts: DeploymentOpts) {}

  protected abstract createDeployment(opts: DeploymentOpts): Promise<ProjectDeployment>;

  async start(): Promise<ProjectDeployment> {
    this.deployment = await this.createDeployment(this.opts);
    await this.deployment.waitForPidnapHostRoute({ timeoutMs: 120_000 });
    return this.deployment;
  }

  protected requireDeployment(): ProjectDeployment {
    if (!this.deployment) throw new Error("deployment not started");
    return this.deployment;
  }

  async configureEgressProxy(externalProxyUrl: string): Promise<void> {
    const deployment = this.requireDeployment();
    await retry(async () => {
      const updated = await deployment.pidnap.processes.updateConfig({
        processSlug: "egress-proxy",
        definition: {
          command: "/opt/pidnap/node_modules/.bin/tsx",
          args: ["/opt/services/egress-service/src/server.ts"],
          env: {
            ...EGRESS_PROCESS_ENV,
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
        timeoutMs: 120_000,
      });
    }, 6);

    await waitForDirectHttp(deployment, {
      url: "http://127.0.0.1:19000/healthz",
      timeoutMs: 120_000,
    });
  }

  async exec(cmd: string | string[]) {
    return await this.requireDeployment().exec(cmd);
  }

  async destroy(): Promise<void> {
    if (!this.deployment) return;
    await this.deployment[Symbol.asyncDispose]();
    this.deployment = null;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.destroy();
  }
}

class DockerFrpDeployment extends FrpDeploymentBase {
  static override readonly implemented = true;
  static override readonly providerName: ProviderName = "docker";

  protected override async createDeployment(opts: DeploymentOpts): Promise<ProjectDeployment> {
    return await dockerProjectDeployment(opts);
  }
}

class FlyFrpDeployment extends FrpDeploymentBase {
  static override readonly implemented = true;
  static override readonly providerName: ProviderName = "fly";

  protected override async createDeployment(opts: DeploymentOpts): Promise<ProjectDeployment> {
    return await flyProjectDeployment(opts);
  }
}

const Providers = [DockerFrpDeployment, FlyFrpDeployment] as const;

for (const Provider of Providers) {
  const providerName = Provider.providerName;
  const enabledByProvider = E2E_PROVIDER === providerName;
  const shouldRun = RUN_E2E && RUN_FRP_E2E && enabledByProvider;
  const image = providerName === "fly" ? FLY_IMAGE : DOCKER_IMAGE;

  describe.runIf(shouldRun)(`jonasland ${providerName} frp egress playground`, () => {
    test("https://example.com egresses via caddy -> egress-proxy -> frp -> vitest mock", async () => {
      if (providerName === "fly" && image.trim().length === 0) {
        throw new Error("Set JONASLAND_E2E_FLY_IMAGE or FLY_DEFAULT_IMAGE for Fly e2e");
      }

      await using proxy = await mockEgressProxy();
      proxy.fetch = async (request) =>
        Response.json({
          ok: true,
          url: request.url,
          path: new URL(request.url).pathname,
          method: request.method,
        });

      await using fixture = new Provider({
        image,
        name: `jonasland-e2e-${providerName}-frp-${randomUUID().slice(0, 8)}`,
      });
      const deployment = await fixture.start();

      await using frpBridge = await startFlyFrpEgressBridge({
        deployment,
        localTargetPort: proxy.port,
        frpcBin: process.env.JONASLAND_E2E_FRPC_BIN,
      });
      await fixture.configureEgressProxy(frpBridge.dataProxyUrl);

      const requestPath = "/vitest-frp-post";
      const payload = JSON.stringify({
        source: `${providerName}-frp-e2e`,
        run: randomUUID().slice(0, 8),
      });
      const payloadShellQuoted = `'${payload.replaceAll("'", "'\"'\"'")}'`;
      const observed = proxy.waitFor((request) => new URL(request.url).pathname === requestPath, {
        timeout: 180_000,
      });

      const curl = await fixture.exec([
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

      const delivered = await observed;
      expect(new URL(delivered.request.url).pathname).toBe(requestPath);
      expect(delivered.request.method).toBe("POST");
      expect(await delivered.request.text()).toBe(payload);
      expect(delivered.request.headers.get("host")).toContain("127.0.0.1:27180");
      expect(delivered.request.headers.get("x-iterate-egress-mode")).toBe("external-proxy");
      expect(delivered.response.status).toBe(200);
    }, 900_000);
  });
}
