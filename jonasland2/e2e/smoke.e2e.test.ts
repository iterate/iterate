import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import {
  dockerContainerFixture,
  dockerPing,
  execInContainer,
  mockttpFixture,
  waitForHttpOk,
  webSocketEchoServerFixture,
} from "./lib/fixtures.ts";

const image = process.env.JONASLAND2_SANDBOX_IMAGE || "jonasland2-sandbox:local";
const concurrentCaseIds = Array.from({ length: 10 }, (_, index) => `case-${String(index + 1)}`);

function headerValue(headers: Record<string, string | string[] | undefined>, name: string) {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

async function waitForHealthyWithLogs(url: string, container: { logs(): Promise<string> }) {
  try {
    await waitForHttpOk(url, 45_000);
  } catch (error) {
    const logs = await container.logs().catch(() => "(container logs unavailable)");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\ncontainer logs:\n${logs}`,
    );
  }
}

describe("mockttp proxy fixture concurrency proof", () => {
  test.concurrent("parallel fixtures bind distinct host ports", async () => {
    const fixtures = await Promise.all(Array.from({ length: 8 }, () => mockttpFixture()));

    try {
      const ports = fixtures.map((fixture) => {
        const port = Number(new URL(fixture.proxyUrl).port);
        expect(Number.isFinite(port)).toBe(true);
        return port;
      });
      expect(new Set(ports).size).toBe(ports.length);
    } finally {
      await Promise.all(fixtures.map((fixture) => fixture[Symbol.asyncDispose]()));
    }
  });

  for (const caseId of concurrentCaseIds) {
    test.concurrent(`isolates handlers on shared route (${caseId})`, async () => {
      await using proxy = await mockttpFixture();
      const sharedEndpoint = await proxy.server.forGet("/shared").thenCallback((request) => ({
        statusCode: 200,
        json: {
          caseId,
          seenHeader: headerValue(request.headers, "x-test-case"),
        },
      }));
      const unmatched = await proxy.server.forUnmatchedRequest().always().thenReply(599);

      await delay(Math.floor(Math.random() * 40));

      const response = await fetch(`${proxy.hostProxyUrl}/shared`, {
        headers: { "x-test-case": caseId },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        caseId,
        seenHeader: caseId,
      });

      const seen = await sharedEndpoint.getSeenRequests();
      expect(seen).toHaveLength(1);
      expect(headerValue(seen[0].headers, "x-test-case")).toBe(caseId);
      const unhandled = await unmatched.getSeenRequests();
      expect(unhandled).toHaveLength(0);
    });
  }

  for (const caseId of concurrentCaseIds.slice(0, 4)) {
    test.concurrent(`late-bound handlers stay isolated (${caseId})`, async () => {
      await using proxy = await mockttpFixture();
      const path = "/late-bind";

      await delay(Math.floor(Math.random() * 40));
      await proxy.server.forGet(path).thenJson(200, { caseId });
      const unmatched = await proxy.server.forUnmatchedRequest().always().thenReply(599);

      const response = await fetch(`${proxy.hostProxyUrl}${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ caseId });
      const unhandled = await unmatched.getSeenRequests();
      expect(unhandled).toHaveLength(0);
    });
  }
});

describe.runIf(await dockerPing())("jonasland2 minimal caddy+egress", () => {
  test("events service exposes /api endpoints and does not expose /api/orpc", async () => {
    await using container = await dockerContainerFixture({
      image,
      name: `jonasland2-e2e-api-${randomUUID()}`,
      exposedPorts: ["80/tcp", "443/tcp", "2019/tcp"],
      extraHosts: ["host.docker.internal:host-gateway"],
      capAdd: ["NET_ADMIN"],
    });

    const caddyHttpPort = await container.publishedPort("80/tcp");
    await waitForHealthyWithLogs(`http://127.0.0.1:${String(caddyHttpPort)}/healthz`, container);
    const eventsReadyDeadline = Date.now() + 60_000;
    let eventsReady = false;
    while (Date.now() < eventsReadyDeadline) {
      const openApiStatus = await execInContainer({
        containerId: container.containerId,
        cmd: [
          "curl",
          "-sS",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "-H",
          "Host: events.iterate.localhost",
          "http://127.0.0.1/api/openapi.json",
        ],
      });
      if (openApiStatus.exitCode === 0 && openApiStatus.output.trim() === "200") {
        eventsReady = true;
        break;
      }
      await delay(150);
    }
    expect(eventsReady).toBe(true);

    const createEventResponse = await execInContainer({
      containerId: container.containerId,
      cmd: [
        "curl",
        "-sS",
        "-H",
        "Host: events.iterate.localhost",
        "-H",
        "content-type: application/json",
        "--data",
        '{"type":"smoke-test","payload":{"source":"e2e"}}',
        "http://127.0.0.1/api/events",
      ],
    });
    expect(createEventResponse.exitCode).toBe(0);
    expect(createEventResponse.output).toContain('"type":"smoke-test"');
    expect(createEventResponse.output).toContain('"source":"e2e"');

    const listEventsResponse = await execInContainer({
      containerId: container.containerId,
      cmd: [
        "curl",
        "-sS",
        "-H",
        "Host: events.iterate.localhost",
        "http://127.0.0.1/api/events?limit=10",
      ],
    });
    expect(listEventsResponse.exitCode).toBe(0);
    expect(listEventsResponse.output).toContain('"events"');
    expect(listEventsResponse.output).toContain('"total"');

    const openapiResponse = await execInContainer({
      containerId: container.containerId,
      cmd: [
        "curl",
        "-sS",
        "-H",
        "Host: events.iterate.localhost",
        "http://127.0.0.1/api/openapi.json",
      ],
    });
    expect(openapiResponse.exitCode).toBe(0);
    expect(openapiResponse.output).toContain('"openapi"');
    expect(openapiResponse.output).toContain('"/events"');
    expect(openapiResponse.output).toContain('"/events/{id}"');

    const scalarDocsResponse = await execInContainer({
      containerId: container.containerId,
      cmd: ["curl", "-sS", "-H", "Host: events.iterate.localhost", "http://127.0.0.1/api/docs"],
    });
    expect(scalarDocsResponse.exitCode).toBe(0);
    expect(scalarDocsResponse.output.toLowerCase()).toContain("scalar");

    const orpcStatus = await execInContainer({
      containerId: container.containerId,
      cmd: [
        "curl",
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "-H",
        "Host: events.iterate.localhost",
        "http://127.0.0.1/api/orpc/hello",
      ],
    });
    expect(orpcStatus.exitCode).toBe(0);
    expect(orpcStatus.output.trim()).toBe("404");
  }, 120_000);

  test("late-bound mockttp rule + curl prove caddy MITM + iptables REDIRECT egress flow", async () => {
    await using proxy = await mockttpFixture();
    const unmatched = await proxy.server
      .forUnmatchedRequest()
      .always()
      .thenCallback((request) => {
        const message = `Unhandled request: ${request.method.toUpperCase()} ${request.url}`;
        return {
          statusCode: 404,
          json: {
            error: "mock_not_found",
            message,
          },
        };
      });

    await using container = await dockerContainerFixture({
      image,
      name: `jonasland2-e2e-${randomUUID()}`,
      env: {
        ITERATE_EXTERNAL_EGRESS_PROXY: proxy.proxyUrl,
      },
      exposedPorts: ["80/tcp", "443/tcp", "2019/tcp"],
      extraHosts: ["host.docker.internal:host-gateway", "upstream.iterate.localhost:203.0.113.10"],
      capAdd: ["NET_ADMIN"],
    });

    const caddyHttpPort = await container.publishedPort("80/tcp");
    const caddyAdminPort = await container.publishedPort("2019/tcp");
    await waitForHealthyWithLogs(`http://127.0.0.1:${String(caddyHttpPort)}/healthz`, container);

    const curlEndpoint = await proxy.server.forGet("/from-curl").thenCallback((request) => ({
      statusCode: 200,
      json: {
        ok: true,
        path: new URL(request.url).pathname,
      },
    }));

    const curl = await execInContainer({
      containerId: container.containerId,
      cmd: [
        "curl",
        "-sS",
        "-i",
        "-k",
        "-H",
        "x-from-container: yes",
        "https://upstream.iterate.localhost/from-curl",
      ],
    });

    expect(curl.exitCode).toBe(0);
    expect(curl.output).toMatch(/HTTP\/\d(?:\.\d)? 200/);
    expect(curl.output.toLowerCase()).toContain("x-egress-mode: external-proxy");
    expect(curl.output.toLowerCase()).toContain("x-egress-proxy-seen: 1");
    expect(curl.output).toContain('{"ok":true,"path":"/from-curl"}');

    const seen = await curlEndpoint.getSeenRequests();
    expect(seen).toHaveLength(1);
    const request = seen[0];
    expect(headerValue(request.headers, "x-from-container")).toBe("yes");
    expect(headerValue(request.headers, "x-egress-proxy-seen")).toBe("1");
    const unhandled = await unmatched.getSeenRequests();
    const upstreamUnhandled = unhandled.filter(
      (entry) => new URL(entry.url).hostname === "upstream.iterate.localhost",
    );
    expect(upstreamUnhandled).toHaveLength(0);

    let caddyAdminReady = false;
    const caddyAdminDeadline = Date.now() + 10_000;
    while (Date.now() < caddyAdminDeadline) {
      try {
        const caddyAdminResponse = await fetch(
          `http://127.0.0.1:${String(caddyAdminPort)}/config/`,
        );
        if (caddyAdminResponse.ok) {
          caddyAdminReady = true;
          break;
        }
      } catch {
        // retry
      }
      await delay(150);
    }
    if (!caddyAdminReady) {
      const caddyAdminInside = await execInContainer({
        containerId: container.containerId,
        cmd: [
          "curl",
          "-sS",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "http://127.0.0.1:2019/config/",
        ],
      });
      expect(caddyAdminInside.exitCode).toBe(0);
      expect(caddyAdminInside.output.trim()).toBe("200");
    }

    const nomad = await execInContainer({
      containerId: container.containerId,
      cmd: ["sh", "-lc", "command -v nomad >/dev/null && echo yes || echo no"],
    });
    expect(nomad.exitCode).toBe(0);
    expect(nomad.output.trim()).toBe("yes");
  }, 120_000);

  test("caddy routes Nomad/Consul/OpenObserve UIs and traces are queryable", async () => {
    await using container = await dockerContainerFixture({
      image,
      name: `jonasland2-e2e-observability-${randomUUID()}`,
      exposedPorts: ["80/tcp", "2019/tcp", "4646/tcp", "8500/tcp"],
      extraHosts: ["host.docker.internal:host-gateway"],
      capAdd: ["NET_ADMIN"],
    });

    const caddyHttpPort = await container.publishedPort("80/tcp");
    const caddyAdminPort = await container.publishedPort("2019/tcp");
    const nomadPort = await container.publishedPort("4646/tcp");
    const consulPort = await container.publishedPort("8500/tcp");

    await waitForHealthyWithLogs(`http://127.0.0.1:${String(caddyHttpPort)}/healthz`, container);

    let caddyAdminReady = false;
    const caddyAdminDeadline = Date.now() + 10_000;
    while (Date.now() < caddyAdminDeadline) {
      try {
        const caddyAdmin = await fetch(`http://127.0.0.1:${String(caddyAdminPort)}/config/`);
        if (caddyAdmin.ok) {
          caddyAdminReady = true;
          break;
        }
      } catch {
        // retry
      }
      await delay(150);
    }
    if (!caddyAdminReady) {
      const caddyAdminInside = await execInContainer({
        containerId: container.containerId,
        cmd: [
          "curl",
          "-sS",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "http://127.0.0.1:2019/config/",
        ],
      });
      expect(caddyAdminInside.exitCode).toBe(0);
      expect(caddyAdminInside.output.trim()).toBe("200");
    }

    const nomadDirect = await fetch(`http://127.0.0.1:${String(nomadPort)}/ui/`);
    expect(nomadDirect.ok).toBe(true);
    expect(await nomadDirect.text()).toContain("<title>Nomad</title>");

    const consulDirect = await fetch(`http://127.0.0.1:${String(consulPort)}/ui/`);
    expect(consulDirect.ok).toBe(true);
    expect(await consulDirect.text()).toContain("<title>Consul by HashiCorp</title>");

    const nomadViaCaddy = await execInContainer({
      containerId: container.containerId,
      cmd: [
        "sh",
        "-lc",
        "curl -fsSL -H 'Host: nomad.iterate.localhost' http://127.0.0.1/ui/ | grep -qi '<title>Nomad</title>'",
      ],
    });
    expect(nomadViaCaddy.exitCode).toBe(0);

    const consulViaCaddy = await execInContainer({
      containerId: container.containerId,
      cmd: [
        "sh",
        "-lc",
        "curl -fsSL -H 'Host: consul.iterate.localhost' http://127.0.0.1/ui/ | grep -qi '<title>Consul by HashiCorp</title>'",
      ],
    });
    expect(consulViaCaddy.exitCode).toBe(0);

    let openobserveViaCaddyReady = false;
    const openobserveViaCaddyDeadline = Date.now() + 30_000;
    while (Date.now() < openobserveViaCaddyDeadline) {
      const openobserveViaCaddy = await execInContainer({
        containerId: container.containerId,
        cmd: [
          "sh",
          "-lc",
          "curl -fsSL -H 'Host: openobserve.iterate.localhost' http://127.0.0.1/web/login | grep -qi '<title>OpenObserve'",
        ],
      });
      if (openobserveViaCaddy.exitCode === 0) {
        openobserveViaCaddyReady = true;
        break;
      }
      await delay(200);
    }
    expect(openobserveViaCaddyReady).toBe(true);

    const traffic = await execInContainer({
      containerId: container.containerId,
      cmd: [
        "sh",
        "-lc",
        'i=1; while [ "$i" -le 120 ]; do if curl -fsS -H \'Host: orders.iterate.localhost\' -H \'content-type: application/json\' --data \'{"sku":"trace-smoke","quantity":1}\' http://127.0.0.1/api/orders >/dev/null; then break; fi; sleep 0.25; i=$((i + 1)); done; [ "$i" -le 120 ] || exit 1; for _ in $(seq 1 9); do curl -fsS -H \'Host: orders.iterate.localhost\' -H \'content-type: application/json\' --data \'{"sku":"trace-smoke","quantity":1}\' http://127.0.0.1/api/orders >/dev/null || exit 1; done; echo ok',
      ],
    });
    expect(traffic.exitCode).toBe(0);
    expect(traffic.output).toContain("ok");

    let traceSummary:
      | {
          total: number;
          hits: number;
          services: string[];
        }
      | undefined;

    const tracesDeadline = Date.now() + 30_000;
    while (Date.now() < tracesDeadline) {
      const traces = await execInContainer({
        containerId: container.containerId,
        cmd: [
          "node",
          "-e",
          "const run=async()=>{const start=(Date.now()-20*60*1000)*1000;const end=Date.now()*1000;const q=new URLSearchParams({filter:'',start_time:String(start),end_time:String(end),from:'0',size:'50'});const response=await fetch('http://127.0.0.1:5080/api/default/default/traces/latest?'+q,{headers:{Authorization:'Basic cm9vdEBleGFtcGxlLmNvbTpDb21wbGV4cGFzcyMxMjM='}});if(!response.ok){throw new Error('openobserve traces query failed: '+response.status);}const payload=await response.json();const hits=Array.isArray(payload.hits)?payload.hits:[];const services=[...new Set(hits.flatMap((hit)=>Array.isArray(hit.service_name)?hit.service_name.map((entry)=>entry?.service_name).filter(Boolean):[]))];console.log(JSON.stringify({total:Number(payload.total??0),hits:hits.length,services}));};run().catch((error)=>{console.error(String(error));process.exit(1);});",
        ],
      });

      if (traces.exitCode !== 0) {
        await delay(300);
        continue;
      }

      try {
        traceSummary = JSON.parse(traces.output.trim()) as {
          total: number;
          hits: number;
          services: string[];
        };
      } catch {
        await delay(300);
        continue;
      }

      if (
        traceSummary.total > 0 &&
        traceSummary.services.includes("jonasland2-orders-service") &&
        traceSummary.services.includes("jonasland2-events-service")
      ) {
        break;
      }

      await delay(300);
    }

    expect(traceSummary).toBeDefined();
    expect(traceSummary?.total).toBeGreaterThan(0);
    expect(traceSummary?.hits).toBeGreaterThan(0);
    expect(traceSummary?.services).toContain("jonasland2-orders-service");
    expect(traceSummary?.services).toContain("jonasland2-events-service");
  }, 180_000);

  test("nomad services recover after container restart (non-dev agent)", async () => {
    await using container = await dockerContainerFixture({
      image,
      name: `jonasland2-e2e-restart-${randomUUID()}`,
      exposedPorts: ["80/tcp", "4646/tcp", "8500/tcp", "2019/tcp"],
      extraHosts: ["host.docker.internal:host-gateway"],
      capAdd: ["NET_ADMIN"],
    });

    let caddyHttpPort = await container.publishedPort("80/tcp");
    let nomadPort = await container.publishedPort("4646/tcp");
    let consulPort = await container.publishedPort("8500/tcp");

    const waitForCoreServices = async () => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(
            `http://127.0.0.1:${String(consulPort)}/v1/catalog/services`,
          );
          if (response.ok) {
            const services = (await response.json()) as Record<string, unknown>;
            const required = ["caddy", "events-service", "orders-service", "openobserve"];
            if (required.every((name) => name in services)) {
              return services;
            }
          }
        } catch {
          // retry
        }
        await delay(300);
      }

      throw new Error("timed out waiting for core services in consul catalog");
    };
    const readNomadDevMode = async () => {
      const response = await fetch(`http://127.0.0.1:${String(nomadPort)}/v1/agent/self`);
      expect(response.ok).toBe(true);
      const payload = (await response.json()) as {
        config?: {
          DevMode?: boolean;
        };
      };
      return payload.config?.DevMode ?? false;
    };
    const waitForNomadJobRunning = async (jobId: string) => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(
            `http://127.0.0.1:${String(nomadPort)}/v1/job/${jobId}/summary`,
          );
          if (!response.ok) {
            await delay(300);
            continue;
          }
          const payload = (await response.json()) as {
            Summary?: Record<
              string,
              {
                Running?: number;
              }
            >;
          };
          const groups = Object.values(payload.Summary ?? {});
          if (groups.some((group) => (group.Running ?? 0) > 0)) {
            return;
          }
        } catch {
          // retry
        }
        await delay(300);
      }

      throw new Error(`timed out waiting for running nomad job: ${jobId}`);
    };

    await waitForHealthyWithLogs(`http://127.0.0.1:${String(caddyHttpPort)}/healthz`, container);
    await waitForHttpOk(`http://127.0.0.1:${String(nomadPort)}/v1/status/leader`, 60_000);
    await waitForCoreServices();

    expect(await readNomadDevMode()).toBe(false);

    await container.restart();
    caddyHttpPort = await container.publishedPort("80/tcp");
    nomadPort = await container.publishedPort("4646/tcp");
    consulPort = await container.publishedPort("8500/tcp");

    await waitForHealthyWithLogs(`http://127.0.0.1:${String(caddyHttpPort)}/healthz`, container);
    await waitForHttpOk(`http://127.0.0.1:${String(nomadPort)}/v1/status/leader`, 90_000);
    await waitForCoreServices();

    expect(await readNomadDevMode()).toBe(false);

    await waitForNomadJobRunning("caddy");
    await waitForNomadJobRunning("events-service");
    await waitForNomadJobRunning("orders-service");
  }, 240_000);

  test("websockets are proxied via caddy+egress and upstream sees proxy headers", async () => {
    await using wsUpstream = await webSocketEchoServerFixture();

    await using container = await dockerContainerFixture({
      image,
      name: `jonasland2-e2e-ws-${randomUUID()}`,
      env: {
        ITERATE_EXTERNAL_EGRESS_PROXY: wsUpstream.url,
      },
      exposedPorts: ["80/tcp", "443/tcp"],
      extraHosts: ["host.docker.internal:host-gateway", "upstream.iterate.localhost:203.0.113.10"],
      capAdd: ["NET_ADMIN"],
    });

    const caddyHttpPort = await container.publishedPort("80/tcp");
    await waitForHealthyWithLogs(`http://127.0.0.1:${String(caddyHttpPort)}/healthz`, container);

    const wsClient = await execInContainer({
      containerId: container.containerId,
      cmd: [
        "node",
        "-e",
        "const ws=new WebSocket('ws://upstream.iterate.localhost/ws-check');const t=setTimeout(()=>{console.error('timeout');process.exit(1)},6000);ws.addEventListener('open',()=>ws.send('hello'));ws.addEventListener('message',(e)=>{console.log(String(e.data));ws.close();});ws.addEventListener('close',()=>{clearTimeout(t);process.exit(0)});ws.addEventListener('error',(e)=>{console.error(String(e?.message||'ws-error'));clearTimeout(t);process.exit(1)});",
      ],
    });

    expect(wsClient.exitCode).toBe(0);
    expect(wsClient.output).toContain("echo:hello");

    const handshake = await wsUpstream.waitForHandshake({ pathname: "/ws-check" });
    expect(handshake.headers["x-egress-proxy-seen"]).toBe("1");
    expect(handshake.headers["x-egress-mode"]).toBe("external-proxy");
  }, 120_000);
});
