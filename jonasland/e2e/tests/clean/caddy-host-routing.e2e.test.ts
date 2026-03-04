/**
 * Caddy host routing + egress tests.
 *
 * Verifies:
 * 1) All three host forms (internal, subdomain, dunder) route correctly
 * 2) Host header arrives intact at upstream via /api/echo
 * 3) X-Forwarded-Host rewrite behavior
 * 4) Public internet egress works (iptables → Caddy → egress → internet)
 * 5) External egress proxy mode routes through the configured proxy
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
    // Each entry: [label, hostHeader, healthPath, expectedServiceName]
    //
    // We use /api/service/health (available on every service) and assert
    // the "service" field in the JSON response to prove the request
    // reached the correct upstream — not just that something responded.
    //
    // Bootstrap services: pidnap, registry
    // Registry-managed: events, example
    const healthCases: Array<[string, string, string, string]> = [
      // Bootstrap: registry (has /api/service/health via oRPC)
      [
        "registry internal",
        "registry.iterate.localhost",
        "/api/service/health",
        "jonasland-registry-service",
      ],
      [
        "registry subdomain",
        `registry.${publicBaseHost}`,
        "/api/service/health",
        "jonasland-registry-service",
      ],
      [
        "registry dunder",
        `registry__${publicBaseHost}`,
        "/api/service/health",
        "jonasland-registry-service",
      ],

      // Registry-managed: events
      [
        "events internal",
        "events.iterate.localhost",
        "/api/service/health",
        "jonasland-events-service",
      ],
      [
        "events subdomain",
        `events.${publicBaseHost}`,
        "/api/service/health",
        "jonasland-events-service",
      ],
      [
        "events dunder",
        `events__${publicBaseHost}`,
        "/api/service/health",
        "jonasland-events-service",
      ],

      // Registry-managed (dynamic): example
      ["example internal", "example.iterate.localhost", "/api/service/health", "jonasland-example"],
      [
        "example subdomain",
        `example.${publicBaseHost}`,
        "/api/service/health",
        "jonasland-example",
      ],
      ["example dunder", `example__${publicBaseHost}`, "/api/service/health", "jonasland-example"],
    ];

    for (const [label, host, path, expectedService] of healthCases) {
      const result = await curlWithHost({ deployment, host, path });
      expect(result.exitCode, `${label} (host=${host}): ${result.output}`).toBe(0);
      const body = JSON.parse(result.output) as Record<string, unknown>;
      expect(body.service, `${label}: wrong service (got ${String(body.service)})`).toBe(
        expectedService,
      );
    }

    // Bootstrap: pidnap (no /api/service/health — uses /rpc, just verify reachability)
    for (const host of [
      "pidnap.iterate.localhost",
      `pidnap.${publicBaseHost}`,
      `pidnap__${publicBaseHost}`,
    ]) {
      const result = await curlWithHost({ deployment, host, path: "/rpc" });
      expect(result.exitCode, `pidnap (host=${host}): ${result.output}`).toBe(0);
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

  test("public internet egress works via iptables redirect", async () => {
    await using deployment = await DockerDeployment.create({
      dockerImage: DOCKER_IMAGE,
      name: `e2e-egress-public-${randomUUID().slice(0, 8)}`,
    });
    await deployment.waitUntilAlive({ signal: AbortSignal.timeout(120_000) });

    // httpbin.org/get is a well-known public echo service.
    // curl from inside the container goes: process → iptables → Caddy :443
    // (MITM TLS) → egress fallback → egress-service → internet.
    // The egress proxy is started automatically by pidnap.
    const deadline = Date.now() + 30_000;
    let result = { exitCode: 1, output: "" };
    while (Date.now() < deadline) {
      result = await deployment.exec([
        "curl",
        "-k",
        "-sS",
        "--max-time",
        "10",
        "https://httpbin.org/get?from=iterate-egress-test",
      ]);
      if (result.exitCode === 0) break;
      await sleep(1_000);
    }
    expect(result.exitCode, `public egress curl: ${result.output}`).toBe(0);

    const body = JSON.parse(result.output) as Record<string, unknown>;
    const args = body.args as Record<string, string> | undefined;
    expect(args?.from).toBe("iterate-egress-test");
  }, 180_000);

  test("external egress proxy routes traffic through configured proxy", async () => {
    await using deployment = await DockerDeployment.create({
      dockerImage: DOCKER_IMAGE,
      name: `e2e-egress-extproxy-${randomUUID().slice(0, 8)}`,
      env: {
        ITERATE_EXTERNAL_EGRESS_PROXY: "http://127.0.0.1:19123",
      },
    });
    await deployment.waitUntilAlive({ signal: AbortSignal.timeout(120_000) });

    // Start an inline echo server on :19123 that acts as the "external egress
    // proxy". It returns JSON with via=test-external-proxy so we can verify
    // the egress service routed through it.
    await deployment.pidnap.processes.updateConfig({
      processSlug: "test-external-proxy",
      definition: {
        command: "node",
        args: [
          "-e",
          [
            "const { createServer } = require('node:http');",
            "createServer((req, res) => {",
            "  const chunks = [];",
            "  req.on('data', c => chunks.push(c));",
            "  req.on('end', () => {",
            "    const body = Buffer.concat(chunks).toString();",
            "    res.writeHead(200, {",
            "      'content-type': 'application/json',",
            "      'x-test-external-proxy': '1'",
            "    });",
            "    res.end(JSON.stringify({",
            "      via: 'test-external-proxy',",
            "      host: req.headers.host || '',",
            "      url: req.url || '',",
            "      method: req.method,",
            "      headers: req.headers,",
            "      body: body || ''",
            "    }));",
            "  });",
            "}).listen(19123, '0.0.0.0');",
          ].join(" "),
        ],
      },
      options: { restartPolicy: "always" },
      envOptions: { reloadDelay: false },
      healthCheck: {
        url: "http://127.0.0.1:19123/healthz",
        intervalMs: 2_000,
      },
    });
    const proxyReady = await deployment.pidnap.processes.waitFor({
      processes: { "test-external-proxy": "healthy" },
      timeoutMs: 20_000,
    });
    expect(proxyReady.allMet).toBe(true);

    // The egress proxy is already running (started by pidnap). It picks up
    // ITERATE_EXTERNAL_EGRESS_PROXY from the deployment env, pointing at
    // the inline echo server on :19123.

    // Make an outbound HTTPS request. iptables redirects it to Caddy, Caddy
    // falls through to egress-service (:19000), egress-service forwards to
    // the external proxy (:19123), which echoes back our request details.
    const deadline = Date.now() + 30_000;
    let result = { exitCode: 1, output: "" };
    while (Date.now() < deadline) {
      result = await deployment.exec([
        "curl",
        "-k",
        "-sS",
        "-i",
        "--max-time",
        "10",
        "-H",
        "x-iterate-test: external-proxy-check",
        "https://api.example.com/test-path?from=ext-proxy",
      ]);
      if (
        result.exitCode === 0 &&
        result.output.includes("x-test-external-proxy: 1") &&
        result.output.includes("x-iterate-egress-proxy-seen: 1")
      ) {
        break;
      }
      await sleep(1_000);
    }
    expect(result.exitCode, `external proxy curl: ${result.output}`).toBe(0);
    expect(result.output).toContain("x-test-external-proxy: 1");
    expect(result.output).toContain("x-iterate-egress-proxy-seen: 1");
    expect(result.output).toContain("x-iterate-egress-mode: external-proxy");
    expect(result.output).toContain('"via":"test-external-proxy"');
  }, 180_000);
});
