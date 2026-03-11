import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { useMockHttpServer } from "@iterate-com/mock-http-proxy";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { createDockerProvider } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { test } from "../../test-support/e2e-test.ts";

const DOCKER_IMAGE = process.env.E2E_DOCKER_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";

describe.runIf(DOCKER_IMAGE.length > 0)("docker host proxy egress", () => {
  test("pnpm install works via host.docker.internal external proxy", async ({ e2e }) => {
    const runId = randomUUID().slice(0, 8);
    const artifactsDir = join(process.cwd(), "artifacts", "docker-host-proxy");
    await mkdir(artifactsDir, { recursive: true });
    const harPath = join(artifactsDir, `docker-host-proxy-${runId}.har`);

    let egressProofOutput = "";
    // block scope - at the end of which the har file gets written
    {
      await using mockServer = await useMockHttpServer({
        recorder: { enabled: true, harPath },
        onUnhandledRequest: "bypass",
      });
      const proxyUrl = `http://host.docker.internal:${String(mockServer.port)}`;

      const deployment = await Deployment.create({
        provider: createDockerProvider({}),
        opts: {
          slug: `e2e-docker-host-proxy-${runId}`,
          image: DOCKER_IMAGE,
          env: {
            ITERATE_EGRESS_PROXY: proxyUrl,
            EXTERNAL_EGRESS_PROXY_URL: proxyUrl,
          },
        },
      });
      await using _deployment = await e2e.useDeployment({ deployment });
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

      const egressProof = await deployment.exec([
        "curl",
        "-k",
        "-sS",
        "-i",
        "--max-time",
        "20",
        "https://example.com/docker-host-proxy-proof",
      ]);
      expect(egressProof.exitCode, egressProof.output).toBe(0);
      egressProofOutput = egressProof.output;
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

    if (requests.length === 0) {
      expect(egressProofOutput.toLowerCase()).toContain("x-iterate-egress-mode: external-proxy");
      expect(egressProofOutput.toLowerCase()).toContain("x-iterate-egress-proxy-seen: 1");
      return;
    }
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
      requests.every((request) => request.status > 0 && request.status < 600),
      `expected valid HTTP responses for proxied requests, saw:\n${requestSummary}`,
    ).toBe(true);
  }, 180_000);
});
