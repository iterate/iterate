/**
 * Table-driven Caddy host routing test.
 *
 * Verifies that all three host forms (internal, subdomain, dunder) route to
 * the correct upstream for both bootstrap and registry-managed services.
 * Uses the example service's /api/echo endpoint to assert the Host header
 * that actually arrives at the upstream.
 *
 * Also verifies X-Forwarded-Host rewrite behavior.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { exampleServiceManifest } from "@iterate-com/example-contract";
import { serviceManifestToPidnapConfig } from "@iterate-com/shared/jonasland";
import type { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";

const DOCKER_IMAGE = process.env.E2E_DOCKER_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRouteRegistered(
  deployment: Deployment,
  host: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listed = await deployment.registry.routes.list({});
    if (listed.routes.some((r) => r.host === host)) return;
    await sleep(500);
  }
  throw new Error(`route ${host} not registered within ${String(timeoutMs)}ms`);
}

async function curlWithHost(params: {
  deployment: Deployment;
  host: string;
  path: string;
  extraHeaders?: Record<string, string>;
}): Promise<{ exitCode: number; output: string }> {
  const args = ["curl", "-fsS", "--max-time", "10"];
  args.push("-H", `Host: ${params.host}`);
  for (const [key, value] of Object.entries(params.extraHeaders ?? {})) {
    args.push("-H", `${key}: ${value}`);
  }
  args.push(`http://127.0.0.1${params.path}`);
  return await params.deployment.exec(args);
}

async function curlEcho(params: {
  deployment: Deployment;
  host: string;
}): Promise<Record<string, unknown>> {
  const result = await curlWithHost({
    deployment: params.deployment,
    host: params.host,
    path: "/api/echo?from=caddy-routing-test",
  });
  if (result.exitCode !== 0) {
    throw new Error(`curl echo failed for host=${params.host}: ${result.output}`);
  }
  return JSON.parse(result.output) as Record<string, unknown>;
}

describe.runIf(DOCKER_IMAGE.length > 0)("caddy host routing", () => {
  test("all host forms route correctly for bootstrap and registry-managed services", async () => {
    const publicBaseHost = `test-${randomUUID().slice(0, 8)}.example.com`;

    await using deployment = await DockerDeployment.create({
      dockerImage: DOCKER_IMAGE,
      name: `e2e-caddy-routing-${randomUUID().slice(0, 8)}`,
    });
    await deployment.waitUntilAlive({ signal: AbortSignal.timeout(120_000) });

    await deployment.setEnvVars({
      ITERATE_PUBLIC_BASE_HOST: publicBaseHost,
      ITERATE_PUBLIC_BASE_HOST_TYPE: "prefix",
    });

    // Start example service so we can use /api/echo.
    const pidnapConfigs = serviceManifestToPidnapConfig({
      manifests: [exampleServiceManifest],
    });
    for (const config of pidnapConfigs) {
      await deployment.pidnap.processes.updateConfig(config);
    }
    await waitForRouteRegistered(deployment, "example.iterate.localhost", 60_000);

    // Wait for registry to pick up the new ITERATE_PUBLIC_BASE_HOST and
    // re-sync Caddy fragments with the updated host patterns.
    const registryDeadline = Date.now() + 30_000;
    while (Date.now() < registryDeadline) {
      try {
        const result = await deployment.registry.getPublicURL({
          internalURL: "http://example.iterate.localhost",
        });
        if (result.publicURL.includes(publicBaseHost)) break;
      } catch {
        /* registry may be mid-restart */
      }
      await sleep(500);
    }

    // -----------------------------------------------------------------
    // Table-driven host routing assertions
    // -----------------------------------------------------------------
    // Each entry: [label, hostHeader, service, shouldSucceed]
    //
    // Bootstrap services: pidnap, registry, caddy
    // Registry-managed: events, example
    const healthCases: Array<[string, string, string]> = [
      // Bootstrap: pidnap
      ["pidnap internal", "pidnap.iterate.localhost", "/rpc"],
      ["pidnap subdomain", `pidnap.${publicBaseHost}`, "/rpc"],
      ["pidnap dunder", `pidnap__${publicBaseHost}`, "/rpc"],

      // Bootstrap: registry
      ["registry internal", "registry.iterate.localhost", "/api/routes"],
      ["registry subdomain", `registry.${publicBaseHost}`, "/api/routes"],
      ["registry dunder", `registry__${publicBaseHost}`, "/api/routes"],

      // Registry-managed: events
      ["events internal", "events.iterate.localhost", "/api/service/health"],
      ["events subdomain", `events.${publicBaseHost}`, "/api/service/health"],
      ["events dunder", `events__${publicBaseHost}`, "/api/service/health"],
    ];

    for (const [label, host, path] of healthCases) {
      const result = await curlWithHost({ deployment, host, path });
      expect(result.exitCode, `${label} (host=${host}): ${result.output}`).toBe(0);
    }

    // Echo-based Host header verification (example service).
    const echoCases: Array<[string, string]> = [
      ["example internal", "example.iterate.localhost"],
      ["example subdomain", `example.${publicBaseHost}`],
      ["example dunder", `example__${publicBaseHost}`],
    ];

    for (const [label, host] of echoCases) {
      const payload = await curlEcho({ deployment, host });
      expect(payload.host, `${label}: expected host=${host}`).toBe(host);
      expect(String(payload.url)).toContain("/api/echo?from=caddy-routing-test");
    }

    // X-Forwarded-Host rewrite: XFH should override Host for routing.
    const xfhHost = `example__${publicBaseHost}`;
    const xfhResult = await deployment.exec([
      "curl",
      "-fsS",
      "--max-time",
      "10",
      "-H",
      "Host: something-unrelated.test",
      "-H",
      `X-Forwarded-Host: ${xfhHost}`,
      "http://127.0.0.1/api/echo?from=xfh-test",
    ]);
    expect(xfhResult.exitCode, `XFH rewrite: ${xfhResult.output}`).toBe(0);
    const xfhPayload = JSON.parse(xfhResult.output) as Record<string, unknown>;
    expect(xfhPayload.host).toBe(xfhHost);
  }, 180_000);
});
