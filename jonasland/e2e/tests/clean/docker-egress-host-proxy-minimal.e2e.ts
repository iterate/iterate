import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { useMockHttpServer } from "@iterate-com/mock-http-proxy";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";

const DOCKER_IMAGE = process.env.E2E_DOCKER_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";

describe.runIf(DOCKER_IMAGE.length > 0)("docker host proxy egress", () => {
  test("pnpm install works via host.docker.internal external proxy", async () => {
    const runId = randomUUID().slice(0, 8);
    const artifactsDir = join(process.cwd(), "artifacts", "docker-host-proxy");
    await mkdir(artifactsDir, { recursive: true });
    const harPath = join(artifactsDir, `docker-host-proxy-${runId}.har`);

    // block scope - at the end of which the har file gets written
    {
      await using mockServer = await useMockHttpServer({
        recorder: { enabled: true, harPath },
        onUnhandledRequest: "bypass",
      });
      const proxyUrl = `http://host.docker.internal:${String(mockServer.port)}`;

      await using deployment = await DockerDeployment.create({
        dockerImage: DOCKER_IMAGE,
        name: `e2e-docker-host-proxy-${runId}`,
        env: {
          ITERATE_EXTERNAL_EGRESS_PROXY: proxyUrl,
          EXTERNAL_EGRESS_PROXY_URL: proxyUrl,
        },
      });
      await deployment.waitUntilAlive({ signal: AbortSignal.timeout(180_000) });

      // install some packages from npm in a temp directory
      const install = await deployment.exec([
        "sh",
        "-lc",
        [
          "rm -rf /tmp/pnpm-host-proxy-install",
          "mkdir -p /tmp/pnpm-host-proxy-install",
          'cat > /tmp/pnpm-host-proxy-install/package.json <<\'EOF\'\n{"name":"pnpm-host-proxy-install","private":true,"version":"1.0.0","dependencies":{"is-number":"^7.0.0"}}\nEOF',
          "CI=true pnpm --dir /tmp/pnpm-host-proxy-install install --registry=https://registry.npmjs.org --ignore-scripts",
          "curl -fsS https://registry.npmjs.org/is-number > /dev/null",
          "curl -fsS https://example.com > /dev/null",
        ].join(" && "),
      ]);
      expect(install.exitCode, install.output).toBe(0);
    }
    // end of block scope - now the har file is written and we can read it

    const har = JSON.parse(await readFile(harPath, "utf8")) as {
      log?: {
        entries?: Array<{
          request?: {
            method?: string;
            url?: string;
            headers?: Array<{ name?: string; value?: string }>;
          };
          response?: {
            status?: number;
          };
        }>;
      };
    };
    const entries = har.log?.entries ?? [];
    const requests = entries
      .map((entry) => {
        const url = entry.request?.url ?? "";
        const parsed =
          url.length > 0
            ? (() => {
                try {
                  return new URL(url);
                } catch {
                  return null;
                }
              })()
            : null;
        return {
          method: entry.request?.method ?? "UNKNOWN",
          url,
          host: parsed?.host ?? "invalid-url",
          pathname: parsed?.pathname ?? "invalid-path",
          status: entry.response?.status ?? 0,
          headers: entry.request?.headers ?? [],
        };
      })
      .filter((request) => request.url.length > 0);
    const requestSummary = requests
      .map(
        (request) =>
          `${request.method} ${request.host}${request.pathname} -> ${String(request.status)}`,
      )
      .join("\n");

    expect(
      requests.length,
      `expected at least one proxied request, saw:\n${requestSummary}`,
    ).toBeGreaterThan(0);
    expect(
      requests.filter((request) => request.host.includes("geoip.zinclabs.dev")).length,
      `expected at least one concrete outbound destination, saw:\n${requestSummary}`,
    ).toBeGreaterThan(0);
    expect(
      requests.every((request) =>
        request.headers.some(
          (header) =>
            header.name?.toLowerCase() === "x-iterate-egress-mode" &&
            header.value === "external-proxy",
        ),
      ),
      `expected every request to be tagged as external-proxy egress, saw:\n${requestSummary}`,
    ).toBe(true);
    expect(
      requests.every((request) =>
        request.headers.some(
          (header) =>
            header.name?.toLowerCase() === "x-iterate-egress-proxy-seen" && header.value === "1",
        ),
      ),
      `expected every request to pass through configured external proxy, saw:\n${requestSummary}`,
    ).toBe(true);
    expect(
      requests.every((request) => request.status > 0 && request.status < 500),
      `expected non-5xx responses for proxied requests, saw:\n${requestSummary}`,
    ).toBe(true);
  }, 180_000);
});
