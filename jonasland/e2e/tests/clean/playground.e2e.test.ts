import { randomUUID } from "node:crypto";
import { describe, expect } from "vitest";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { createDockerProvider } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { useCloudflareTunnel } from "../../test-helpers/old/use-cloudflare-tunnel.ts";
import { useIngressProxyRoutes } from "../../test-helpers/old/use-ingress-proxy-routes.ts";
import { test } from "../../test-support/e2e-test.ts";

const DOCKER_IMAGE = process.env.E2E_DOCKER_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const runPlayground = process.env.JONASLAND_E2E_ENABLE_PLAYGROUND === "true";
const DEFAULT_INGRESS_PROXY_BASE_URL = "https://ingress.iterate.com";
const DEFAULT_INGRESS_PROXY_DOMAIN = "ingress.iterate.com";

async function waitForSigint(): Promise<void> {
  await new Promise<void>((resolve) => {
    const onSigint = () => {
      process.off("SIGINT", onSigint);
      resolve();
    };
    process.on("SIGINT", onSigint);
  });
}

describe.runIf(runPlayground && DOCKER_IMAGE.length > 0)("playground", () => {
  test("docker deployment + cloudflare tunnel + ingress routes playground", async ({ e2e }) => {
    const ingressProxyApiKey =
      process.env.INGRESS_PROXY_API_TOKEN?.trim() ??
      process.env.INGRESS_PROXY_E2E_API_TOKEN?.trim() ??
      "";
    if (!ingressProxyApiKey) {
      throw new Error(
        "set INGRESS_PROXY_API_TOKEN (or INGRESS_PROXY_E2E_API_TOKEN) to run this test",
      );
    }

    const ingressProxyBaseUrl = (
      process.env.JONASLAND_E2E_INGRESS_PROXY_BASE_URL ??
      process.env.INGRESS_PROXY_BASE_URL ??
      DEFAULT_INGRESS_PROXY_BASE_URL
    )
      .trim()
      .replace(/\/+$/, "");
    const ingressProxyDomain = (
      process.env.JONASLAND_E2E_INGRESS_PROXY_DOMAIN ??
      process.env.INGRESS_PROXY_DOMAIN ??
      DEFAULT_INGRESS_PROXY_DOMAIN
    ).trim();

    console.log("[playground] step 1/4 creating docker deployment");
    const deployment = await Deployment.create({
      provider: createDockerProvider({}),
      opts: {
        slug: `playground-${randomUUID().slice(0, 8)}`,
        image: DOCKER_IMAGE,
      },
    });
    await using _deployment = await e2e.useDeployment({ deployment });
    console.log(`[playground] deployment base URL: ${deployment.baseUrl}`);
    console.log("[playground] waiting for deployment to become healthy");
    await deployment.waitUntilAlive({ signal: AbortSignal.timeout(30_000) });
    const deploymentPort = Number(new URL(deployment.baseUrl).port);
    expect(deploymentPort).toBeGreaterThan(0);

    console.log("[playground] step 2/4 creating cloudflare tunnel to deployment base URL");
    await using tunnel = await useCloudflareTunnel({
      localPort: deploymentPort,
      cloudflaredBin: process.env.JONASLAND_E2E_CLOUDFLARED_BIN,
    });
    console.log(`[playground] tunnel URL: ${tunnel.tunnelUrl}`);

    const slug = `playground-${randomUUID().slice(0, 8)}`;
    const wildcardHost = `*__${slug}.${ingressProxyDomain}`;
    const rootHost = `${slug}.${ingressProxyDomain}`;
    const tunnelHost = new URL(tunnel.tunnelUrl).host;

    console.log("[playground] step 3/4 creating ingress proxy routes");
    await using routes = await useIngressProxyRoutes({
      ingressProxyApiKey,
      ingressProxyBaseUrl,
      routes: [
        {
          metadata: {
            source: "jonasland-e2e-playground",
            slug,
          },
          patterns: [
            {
              pattern: wildcardHost,
              target: tunnel.tunnelUrl,
              headers: {
                Host: tunnelHost,
              },
            },
            {
              pattern: rootHost,
              target: tunnel.tunnelUrl,
              headers: {
                Host: tunnelHost,
              },
            },
          ],
        },
      ],
    });

    console.log(`[playground] created route IDs: ${routes.routeIds.join(", ")}`);
    console.log("");
    console.log("[playground] ready for manual testing");
    console.log(`[playground] local deployment: ${deployment.baseUrl}`);
    console.log(`[playground] cloudflare tunnel: ${tunnel.tunnelUrl}`);
    console.log(`[playground] ingress wildcard URL pattern: https://${wildcardHost}/`);
    console.log(`[playground] ingress root URL: https://${rootHost}/`);
    console.log(
      "[playground] press Ctrl+C to stop and trigger teardown (routes -> tunnel -> deployment)",
    );
    console.log("");

    console.log("[playground] step 4/4 waiting for Ctrl+C");
    await waitForSigint();
    console.log("[playground] received Ctrl+C, tearing down");
  }, 3_600_000);
});
