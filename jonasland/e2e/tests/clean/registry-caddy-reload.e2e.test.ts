/**
 * Registry public URL lifecycle + host-routing behavior.
 *
 * This verifies:
 * 1) public URL generation updates after ITERATE_INGRESS_HOST changes
 * 2) subdomain and dunder public forms both route
 * 3) Host header arriving at example service reflects the incoming host
 */
import { randomUUID } from "node:crypto";
import { describe, expect } from "vitest";
import { exampleServiceManifest } from "@iterate-com/example-contract";
import { serviceManifestToPidnapConfig } from "@iterate-com/shared/jonasland";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { createDockerProvider } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { resolvePublicIngressUrl } from "@iterate-com/shared/jonasland/ingress-url";
import { test } from "../../test-support/e2e-test.ts";

const DOCKER_IMAGE = process.env.E2E_DOCKER_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const useDockerHostSync = process.env.DOCKER_HOST_SYNC_ENABLED === "true";
const HOST_SYNC_OFFSET = useDockerHostSync ? 180_000 : 0;
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCurlHostSuccess(params: {
  deployment: Deployment;
  host: string;
  path: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  let lastOutput = "";
  while (Date.now() < deadline) {
    const result = await params.deployment.exec([
      "curl",
      "-fsS",
      "--max-time",
      "10",
      "-H",
      `Host: ${params.host}`,
      `http://127.0.0.1${params.path}`,
    ]);
    if (result.exitCode === 0) return;
    lastOutput = result.output;
    await sleep(500);
  }
  throw new Error(`curl failed for host=${params.host}: ${lastOutput}`);
}

async function getPublicURL(deployment: Deployment, internalURL: string): Promise<string> {
  const result = await deployment.registryService.getPublicURL({ internalURL });
  return result.publicURL;
}

async function waitForRouteRegistered(
  deployment: Deployment,
  host: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listed = await deployment.registryService.routes.list({});
    if (listed.routes.some((r: { host: string }) => r.host === host)) return;
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
    async ({ e2e }) => {
      const deployment = await Deployment.create({
        provider: createDockerProvider({}),
        opts: {
          slug: `e2e-registry-lifecycle-${randomUUID().slice(0, 8)}`,
          image: DOCKER_IMAGE,
          ...(useDockerHostSync ? { dockerHostSync: true } : {}),
        },
      });
      await using _deployment = await e2e.useDeployment({ deployment });
      await deployment.waitUntilAlive({ signal: AbortSignal.timeout(120_000 + HOST_SYNC_OFFSET) });

      const eventsInternalURL = "http://events.iterate.localhost/api/__iterate/health";
      const defaultEventsPublicURL = await getPublicURL(deployment, eventsInternalURL);
      expect(defaultEventsPublicURL).toContain(".orb.local");

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
      expect(defaultExamplePublicURL).toContain(".orb.local");

      const slug = randomUUID().slice(0, 8);
      const publicBaseHost = `${slug}.ingress.iterate.com`;

      await deployment.setEnvVars({
        ITERATE_INGRESS_HOST: publicBaseHost,
        ITERATE_INGRESS_ROUTING_TYPE: "dunder-prefix",
      });

      // Compute expected public URLs with the new base.
      const expectedEventsPublicURL = resolvePublicIngressUrl({
        ingressHost: publicBaseHost,
        ingressRoutingType: "dunder-prefix",
        internalUrl: eventsInternalURL,
      });
      const expectedEventsSubdomainPublicURL = resolvePublicIngressUrl({
        ingressHost: publicBaseHost,
        ingressRoutingType: "subdomain-host",
        internalUrl: eventsInternalURL,
      });
      const expectedExamplePublicURL = resolvePublicIngressUrl({
        ingressHost: publicBaseHost,
        ingressRoutingType: "dunder-prefix",
        internalUrl: exampleInternalURL,
      });
      const expectedExampleSubdomainPublicURL = resolvePublicIngressUrl({
        ingressHost: publicBaseHost,
        ingressRoutingType: "subdomain-host",
        internalUrl: exampleInternalURL,
      });

      const publicUrlDeadline = Date.now() + 30_000;
      let eventsPublicURL = "";
      while (Date.now() < publicUrlDeadline) {
        try {
          eventsPublicURL = await getPublicURL(deployment, eventsInternalURL);
          if (
            eventsPublicURL === expectedEventsPublicURL ||
            eventsPublicURL === expectedEventsSubdomainPublicURL
          ) {
            break;
          }
        } catch {
          /* registry may be mid-restart */
        }
        await sleep(500);
      }
      expect([expectedEventsPublicURL, expectedEventsSubdomainPublicURL]).toContain(
        eventsPublicURL,
      );

      // Example might take a moment to stabilize after reload too.
      let examplePublicURL = "";
      const exampleDeadline = Date.now() + 15_000;
      while (Date.now() < exampleDeadline) {
        try {
          examplePublicURL = await getPublicURL(deployment, exampleInternalURL);
          if (
            examplePublicURL === expectedExamplePublicURL ||
            examplePublicURL === expectedExampleSubdomainPublicURL
          ) {
            break;
          }
        } catch {
          /* registry may be mid-restart */
        }
        await sleep(500);
      }
      expect([expectedExamplePublicURL, expectedExampleSubdomainPublicURL]).toContain(
        examplePublicURL,
      );

      const eventsSubdomainHost = new URL(
        resolvePublicIngressUrl({
          ingressHost: publicBaseHost,
          ingressRoutingType: "subdomain-host",
          internalUrl: eventsInternalURL,
        }),
      ).hostname;
      const eventsPrefixHost = new URL(
        resolvePublicIngressUrl({
          ingressHost: publicBaseHost,
          ingressRoutingType: "dunder-prefix",
          internalUrl: eventsInternalURL,
        }),
      ).hostname;

      for (const host of ["events.iterate.localhost", eventsSubdomainHost, eventsPrefixHost]) {
        await waitForCurlHostSuccess({
          deployment,
          host,
          path: "/api/__iterate/health",
          timeoutMs: 15_000,
        });
      }

      const exampleSubdomainHost = new URL(
        resolvePublicIngressUrl({
          ingressHost: publicBaseHost,
          ingressRoutingType: "subdomain-host",
          internalUrl: "http://example.iterate.localhost/api/echo",
        }),
      ).hostname;
      const examplePrefixHost = new URL(
        resolvePublicIngressUrl({
          ingressHost: publicBaseHost,
          ingressRoutingType: "dunder-prefix",
          internalUrl: "http://example.iterate.localhost/api/echo",
        }),
      ).hostname;

      const echoCases = ["example.iterate.localhost", exampleSubdomainHost, examplePrefixHost];
      for (const host of echoCases) {
        const deadline = Date.now() + 20_000;
        let payload: Record<string, unknown> | null = null;
        while (Date.now() < deadline) {
          try {
            payload = await curlJsonWithHost({
              deployment,
              host,
              path: "/api/echo?from=routing-test",
            });
            break;
          } catch {
            await sleep(500);
          }
        }
        if (!payload) {
          throw new Error(`echo route did not stabilize for host=${host}`);
        }
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
