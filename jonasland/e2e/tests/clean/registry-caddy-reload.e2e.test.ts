/**
 * Registry public URL lifecycle test.
 *
 * Verifies the full pipeline: env change -> registry reload -> public URL
 * resolution -> in-container routing via iptables -> Caddy -> service.
 *
 * Steps:
 *   1. Create deployment, wait for alive.
 *   2. Note the default public URL for events (defaults to iterate.localhost).
 *   3. Start example service on-demand, wait for route registration.
 *   4. Set ITERATE_PUBLIC_BASE_URL + _TYPE to a custom ingress hostname.
 *      Pidnap detects the env change (reloadDelay: 500) and reloads registry,
 *      which picks up the new env and re-syncs Caddy fragments.
 *   5. Poll getPublicURL until it reflects the new base URL for both
 *      events (built-in) and example (dynamic).
 *   6. Curl the public URLs from INSIDE the container. iptables redirects
 *      all outbound TCP to Caddy, so the request goes:
 *        curl -> iptables -> Caddy -> Host match -> service
 *      This approach also works on Fly (where external Host must be *.fly.dev)
 *      because the request never leaves the machine.
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

describe.runIf(DOCKER_IMAGE.length > 0)("registry public URL lifecycle", () => {
  test(
    "public URL resolution updates after env change and routes work in-container",
    async () => {
      // ---------------------------------------------------------------
      // Phase 1: create deployment, note default public URL.
      // ---------------------------------------------------------------
      await using deployment = await DockerDeployment.create({
        dockerImage: DOCKER_IMAGE,
        name: `e2e-registry-lifecycle-${randomUUID().slice(0, 8)}`,
        ...(useDockerHostSync ? { dockerHostSync: true } : {}),
      });
      await deployment.waitUntilAlive({ signal: AbortSignal.timeout(120_000 + HOST_SYNC_OFFSET) });

      // Registry defaults ITERATE_PUBLIC_BASE_URL to "http://iterate.localhost".
      // getPublicURL should return something based on that default.
      const eventsInternalURL = "http://events.iterate.localhost/api/service/health";
      const defaultEventsPublicURL = await getPublicURL(deployment, eventsInternalURL);
      expect(defaultEventsPublicURL).toContain("iterate.localhost");

      // ---------------------------------------------------------------
      // Phase 2: start example service, wait for it to register.
      // ---------------------------------------------------------------
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

      // ---------------------------------------------------------------
      // Phase 3: set custom ITERATE_PUBLIC_BASE_URL + _TYPE.
      // ---------------------------------------------------------------
      const slug = randomUUID().slice(0, 8);
      const publicBaseUrl = `https://${slug}.ingress.iterate.com`;

      await deployment.setEnvVars({
        ITERATE_PUBLIC_BASE_URL: publicBaseUrl,
        ITERATE_PUBLIC_BASE_URL_TYPE: "prefix",
      });

      // Compute expected public URLs with the new base.
      const expectedEventsPublicURL = resolvePublicIngressUrl({
        publicBaseUrl,
        publicBaseUrlType: "prefix",
        internalUrl: eventsInternalURL,
      });
      const expectedExamplePublicURL = resolvePublicIngressUrl({
        publicBaseUrl,
        publicBaseUrlType: "prefix",
        internalUrl: exampleInternalURL,
      });

      // ---------------------------------------------------------------
      // Phase 4: poll until getPublicURL reflects the new base URL.
      // Registry reloads automatically via pidnap env watcher.
      // ---------------------------------------------------------------
      // Poll with retry — registry/caddy may be mid-reload.
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

      // ---------------------------------------------------------------
      // Phase 5: curl public URLs from INSIDE the container.
      //
      // iptables redirects all outbound TCP to Caddy. Caddy sees the
      // public hostname (e.g. events__abc.ingress.iterate.com), matches
      // it via the external proxy snippet or a registry .caddy fragment,
      // and reverse-proxies to the right local service.
      //
      // This works identically on Fly where the only way in is through
      // Caddy — the request never leaves the machine.
      // ---------------------------------------------------------------
      const eventsPublicHost = new URL(expectedEventsPublicURL).hostname;
      const eventsPublicPath = new URL(expectedEventsPublicURL).pathname;

      const curlEventsResult = await deployment.exec([
        "curl",
        "-fsS",
        "--max-time",
        "10",
        `http://${eventsPublicHost}${eventsPublicPath}`,
      ]);
      expect(curlEventsResult.exitCode, `curl events: ${curlEventsResult.output}`).toBe(0);

      const examplePublicHost = new URL(expectedExamplePublicURL).hostname;
      const examplePublicPath = new URL(expectedExamplePublicURL).pathname;

      // Example's public host may need a moment for caddy-sync to render
      // the fragment with the public hostname and reload Caddy.
      const curlExampleDeadline = Date.now() + 30_000;
      let curlExampleResult = { exitCode: 1, output: "" };
      while (Date.now() < curlExampleDeadline) {
        curlExampleResult = await deployment.exec([
          "curl",
          "-fsS",
          "--max-time",
          "5",
          `http://${examplePublicHost}${examplePublicPath}`,
        ]);
        if (curlExampleResult.exitCode === 0) break;
        await sleep(1_000);
      }
      expect(curlExampleResult.exitCode, `curl example: ${curlExampleResult.output}`).toBe(0);
    },
    120_000 + HOST_SYNC_OFFSET,
  );
});
