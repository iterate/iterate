import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { once } from "node:events";
import { http, HttpResponse } from "msw";
import { setupServer as setupMswServer } from "msw/node";
import { describe, expect, test } from "vitest";
import { execInContainer } from "../src/docker-api.ts";
import {
  getContainerLogs,
  startSandboxContainer,
  stopAndRemoveContainer,
} from "../src/container-fixture.ts";
import { consulHasPassingService, consulIsHealthy } from "../src/consul-client.ts";
import {
  hasConsulReadyNode,
  hasReadyNode,
  listAllocations,
  submitNomadJob,
  waitForNomadLeader,
} from "../src/nomad-client.ts";
import { waitFor } from "../src/wait.ts";

const RUN_E2E = process.env.RUN_JONASLAND_E2E === "true";
const image = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland-sandbox:local";
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const sandboxRoot = join(repoRoot, "jonasland", "sandbox");

function withEgressProxy(jobHcl: string, proxyUrl?: string): string {
  if (!proxyUrl) return jobHcl;
  return jobHcl.replace(
    'ITERATE_EXTERNAL_EGRESS_PROXY = ""',
    `ITERATE_EXTERNAL_EGRESS_PROXY = "${proxyUrl}"`,
  );
}

function startHostMockServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  return {
    server,
    async listen() {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Mock server address missing");
      }
      return address.port;
    },
    async close() {
      server.close();
      await once(server, "close").catch(() => undefined);
    },
  };
}

async function startNomadStack(params: {
  containerId: string;
  hostPorts: Record<string, number>;
  egressJob: string;
}) {
  const nomadUrl = `http://127.0.0.1:${params.hostPorts["4646/tcp"]}`;
  const consulUrl = `http://127.0.0.1:${params.hostPorts["8500/tcp"]}`;

  await waitFor({
    timeoutMs: 45_000,
    label: "nomad leader",
    fn: async () => waitForNomadLeader(nomadUrl),
  });
  await waitFor({
    timeoutMs: 45_000,
    label: "nomad ready node",
    fn: async () => hasReadyNode(nomadUrl),
  });

  const consulJob = readFileSync(join(sandboxRoot, "nomad/jobs/consul.nomad.hcl"), "utf-8");
  const caddyJob = readFileSync(join(sandboxRoot, "nomad/jobs/caddy.nomad.hcl"), "utf-8");

  await submitNomadJob(nomadUrl, consulJob);
  await waitFor({
    timeoutMs: 45_000,
    label: "consul healthy",
    fn: async () => consulIsHealthy(consulUrl),
  });
  await waitFor({
    timeoutMs: 45_000,
    label: "nomad node with consul fingerprint",
    fn: async () => hasConsulReadyNode(nomadUrl),
  });

  await submitNomadJob(nomadUrl, params.egressJob);
  await submitNomadJob(nomadUrl, caddyJob);

  await waitFor({
    timeoutMs: 60_000,
    label: "allocations running",
    fn: async () => {
      const allocations = await listAllocations(nomadUrl);
      const running = allocations.filter((allocation) => allocation.ClientStatus === "running");
      return running.length >= 3;
    },
  });
  await waitFor({
    timeoutMs: 45_000,
    label: "egress service in consul",
    fn: async () => consulHasPassingService(consulUrl, "egress"),
  });

  await waitFor({
    timeoutMs: 45_000,
    label: "caddy admin endpoint",
    fn: async () => {
      try {
        await execInContainer({
          containerId: params.containerId,
          cmd: ["sh", "-ec", "curl -fsS http://127.0.0.1:2019/config/ >/dev/null"],
        });
        return true;
      } catch {
        return false;
      }
    },
  });
}

describe.runIf(RUN_E2E)("jonasland smoke", () => {
  test("external proxy mode uses ITERATE_EXTERNAL_EGRESS_PROXY and reaches MSW", async () => {
    const seenByMockServer: Array<{ url: string; host?: string }> = [];
    const seenByMsw: string[] = [];

    const mswServer = setupMswServer(
      http.all("https://upstream.iterate.localhost/*", async ({ request }) => {
        seenByMsw.push(request.url);
        return HttpResponse.json({ ok: true, source: "msw" }, { status: 200 });
      }),
    );

    mswServer.listen({ onUnhandledRequest: "bypass" });

    const mockServer = startHostMockServer(async (req, res) => {
      seenByMockServer.push({ url: req.url || "", host: req.headers.host });
      const upstream = await fetch("https://upstream.iterate.localhost/egress-check");
      const upstreamJson = await upstream.json();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ via: "mock-server", upstream: upstreamJson }));
    });

    const mockPort = await mockServer.listen();

    const name = `jonasland-smoke-proxy-${Date.now()}`;
    const container = await startSandboxContainer({ image, name });

    try {
      const egressJobBase = readFileSync(join(sandboxRoot, "nomad/jobs/egress.nomad.hcl"), "utf-8");
      const egressJob = withEgressProxy(
        egressJobBase,
        `http://host.docker.internal:${String(mockPort)}/proxy-target`,
      );

      await startNomadStack({
        containerId: container.id,
        hostPorts: container.hostPorts,
        egressJob,
      });

      const response = await execInContainer({
        containerId: container.id,
        cmd: [
          "curl",
          "-sS",
          "-D",
          "-",
          "-H",
          `Host: host.docker.internal:${String(mockPort)}`,
          "http://127.0.0.1/proxy-path",
        ],
      });

      expect(response.toLowerCase()).toContain("x-egress-mode: external-proxy");
      expect(seenByMockServer.length).toBeGreaterThan(0);
      expect(seenByMsw.length).toBeGreaterThan(0);
    } finally {
      mswServer.close();
      await mockServer.close();
      await stopAndRemoveContainer(container.id);
    }
  });

  test("direct mode forwards to original target when ITERATE_EXTERNAL_EGRESS_PROXY is unset", async () => {
    const seenByMockServer: string[] = [];

    const mockServer = startHostMockServer((req, res) => {
      seenByMockServer.push(req.url || "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, route: "direct" }));
    });

    const mockPort = await mockServer.listen();

    const name = `jonasland-smoke-direct-${Date.now()}`;
    const container = await startSandboxContainer({ image, name });

    try {
      const egressJobBase = readFileSync(join(sandboxRoot, "nomad/jobs/egress.nomad.hcl"), "utf-8");
      await startNomadStack({
        containerId: container.id,
        hostPorts: container.hostPorts,
        egressJob: egressJobBase,
      });

      const response = await execInContainer({
        containerId: container.id,
        cmd: [
          "curl",
          "-sS",
          "-D",
          "-",
          "-H",
          `Host: host.docker.internal:${String(mockPort)}`,
          "http://127.0.0.1/direct-path",
        ],
      });

      expect(response.toLowerCase()).toContain("x-egress-mode: direct");
      expect(seenByMockServer.some((path) => path.includes("/direct-path"))).toBe(true);

      const natRules = await execInContainer({
        containerId: container.id,
        cmd: ["iptables", "-t", "nat", "-S", "OUTPUT"],
      });

      expect(natRules).toContain("--dport 80 -j REDIRECT --to-ports 80");
      expect(natRules).toContain("--dport 443 -j REDIRECT --to-ports 443");
    } finally {
      const logs = await getContainerLogs(container.id);
      if (process.env.DEBUG_JONASLAND_LOGS === "true") {
        console.log(logs);
      }
      await mockServer.close();
      await stopAndRemoveContainer(container.id);
    }
  });
});
