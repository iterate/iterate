/**
 * Registry public URL lifecycle + host-routing behavior.
 *
 * This verifies:
 * 1) public URL generation updates after ITERATE_PUBLIC_BASE_HOST changes
 * 2) subdomain and dunder public forms both route
 * 3) Host header arriving at example service reflects the incoming host
 */
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { exampleServiceManifest } from "@iterate-com/example-contract";
import { serviceManifestToPidnapConfig } from "@iterate-com/shared/jonasland";
import type { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { resolvePublicIngressUrl } from "@iterate-com/shared/jonasland/ingress-url";

const DOCKER_IMAGE = process.env.E2E_DOCKER_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const useDockerHostSync = process.env.DOCKER_HOST_SYNC_ENABLED === "true";
const HOST_SYNC_OFFSET = useDockerHostSync ? 180_000 : 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getPublicURL(deployment: Deployment, internalURL: string): Promise<string> {
  const result = await deployment.registry.getPublicURL({ internalURL });
  return result.publicURL;
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

async function curlJsonWithHost(params: {
  deployment: Deployment;
  host: string;
  path: string;
}): Promise<Record<string, unknown>> {
  const result = await params.deployment.exec([
    "curl",
    "-fsS",
    "--max-time",
    "10",
    "-H",
    `Host: ${params.host}`,
    `http://127.0.0.1${params.path}`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`curl failed for host=${params.host}: ${result.output}`);
  }
  return JSON.parse(result.output) as Record<string, unknown>;
}

describe.runIf(DOCKER_IMAGE.length > 0)("registry public URL lifecycle", () => {
  test(
    "public URL resolution updates after env change and host forms route correctly",
    async () => {
      await using deployment = await DockerDeployment.create({
        dockerImage: DOCKER_IMAGE,
        name: `e2e-registry-lifecycle-${randomUUID().slice(0, 8)}`,
        ...(useDockerHostSync ? { dockerHostSync: true } : {}),
      });
      await deployment.waitUntilAlive({ signal: AbortSignal.timeout(120_000 + HOST_SYNC_OFFSET) });

      const eventsInternalURL = "http://events.iterate.localhost/api/__iterate/health";
      const defaultEventsPublicURL = await getPublicURL(deployment, eventsInternalURL);
      expect(defaultEventsPublicURL).toContain("iterate.localhost");

      const pidnapConfigs = serviceManifestToPidnapConfig({
        manifests: [exampleServiceManifest],
      });
      for (const config of pidnapConfigs) {
        await deployment.pidnap.processes.updateConfig(config);
      }
      const exampleHost = "example.iterate.localhost";
      await waitForRouteRegistered(deployment, exampleHost, 60_000);

      // Example is registered; its public URL also uses the default base.
      const exampleInternalURL = "http://example.iterate.localhost/api/things/ping";
      const defaultExamplePublicURL = await getPublicURL(deployment, exampleInternalURL);
      expect(defaultExamplePublicURL).toContain("iterate.localhost");

      const slug = randomUUID().slice(0, 8);
      const publicBaseHost = `${slug}.ingress.iterate.com`;

      await deployment.setEnvVars({
        ITERATE_PUBLIC_BASE_HOST: publicBaseHost,
        ITERATE_PUBLIC_BASE_HOST_TYPE: "prefix",
      });

      // Compute expected public URLs with the new base.
      const expectedEventsPublicURL = resolvePublicIngressUrl({
        publicBaseHost,
        publicBaseHostType: "prefix",
        internalUrl: eventsInternalURL,
      });
      const expectedExamplePublicURL = resolvePublicIngressUrl({
        publicBaseHost,
        publicBaseHostType: "prefix",
        internalUrl: exampleInternalURL,
      });

      const publicUrlDeadline = Date.now() + 30_000;
      let eventsPublicURL = "";
      while (Date.now() < publicUrlDeadline) {
        try {
          eventsPublicURL = await getPublicURL(deployment, eventsInternalURL);
          if (eventsPublicURL === expectedEventsPublicURL) break;
        } catch {
          /* registry may be mid-restart */
        }
        await sleep(500);
      }
      expect(eventsPublicURL).toBe(expectedEventsPublicURL);

      // Example might take a moment to stabilize after reload too.
      let examplePublicURL = "";
      const exampleDeadline = Date.now() + 15_000;
      while (Date.now() < exampleDeadline) {
        try {
          examplePublicURL = await getPublicURL(deployment, exampleInternalURL);
          if (examplePublicURL === expectedExamplePublicURL) break;
        } catch {
          /* registry may be mid-restart */
        }
        await sleep(500);
      }
      expect(examplePublicURL).toBe(expectedExamplePublicURL);

      const eventsSubdomainHost = new URL(
        resolvePublicIngressUrl({
          publicBaseHost,
          publicBaseHostType: "subdomain",
          internalUrl: eventsInternalURL,
        }),
      ).hostname;
      const eventsPrefixHost = new URL(
        resolvePublicIngressUrl({
          publicBaseHost,
          publicBaseHostType: "prefix",
          internalUrl: eventsInternalURL,
        }),
      ).hostname;

      for (const host of ["events.iterate.localhost", eventsSubdomainHost, eventsPrefixHost]) {
        const result = await deployment.exec([
          "curl",
          "-fsS",
          "--max-time",
          "10",
          "-H",
          `Host: ${host}`,
          "http://127.0.0.1/api/__iterate/health",
        ]);
        expect(result.exitCode, `curl events for host=${host}: ${result.output}`).toBe(0);
      }

      const exampleSubdomainHost = new URL(
        resolvePublicIngressUrl({
          publicBaseHost,
          publicBaseHostType: "subdomain",
          internalUrl: "http://example.iterate.localhost/api/echo",
        }),
      ).hostname;
      const examplePrefixHost = new URL(
        resolvePublicIngressUrl({
          publicBaseHost,
          publicBaseHostType: "prefix",
          internalUrl: "http://example.iterate.localhost/api/echo",
        }),
      ).hostname;

      const echoCases = ["example.iterate.localhost", exampleSubdomainHost, examplePrefixHost];
      for (const host of echoCases) {
        const payload = await curlJsonWithHost({
          deployment,
          host,
          path: "/api/echo?from=routing-test",
        });
        expect(payload.host).toBe(host);
        expect(String(payload.url)).toContain("/api/echo?from=routing-test");
      }

      // Simulate ingress worker behavior that sends X-Forwarded-Host.
      const forwarded = await deployment.exec([
        "curl",
        "-fsS",
        "--max-time",
        "10",
        "-H",
        "Host: ignored.localhost",
        "-H",
        `X-Forwarded-Host: ${examplePrefixHost}`,
        "http://127.0.0.1/api/echo?from=xfh",
      ]);
      expect(forwarded.exitCode, forwarded.output).toBe(0);
      const forwardedPayload = JSON.parse(forwarded.output) as Record<string, unknown>;
      expect(forwardedPayload.host).toBe(examplePrefixHost);
    },
    120_000 + HOST_SYNC_OFFSET,
  );
});
