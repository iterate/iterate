import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import {
  dockerContainerFixture,
  dockerPing,
  execInContainer,
  mswProxyFixture,
  waitForHttpOk,
  webSocketEchoServerFixture,
} from "./lib/fixtures.ts";

const image = process.env.JONASLAND2_SANDBOX_IMAGE || "jonasland2-sandbox:local";
const concurrentCaseIds = Array.from({ length: 10 }, (_, index) => `case-${String(index + 1)}`);

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

describe("msw proxy fixture concurrency proof", () => {
  test.concurrent("parallel fixtures bind distinct host ports", async () => {
    const fixtures = await Promise.all(
      Array.from({ length: 8 }, () => mswProxyFixture({ onUnhandledRequest: "error" })),
    );

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
      await using msw = await mswProxyFixture({ onUnhandledRequest: "error" });
      msw.use(
        http.get("https://upstream.iterate.localhost/shared", ({ request }) => {
          return HttpResponse.json({
            caseId,
            seenHeader: request.headers.get("x-test-case"),
          });
        }),
      );

      await delay(Math.floor(Math.random() * 40));

      const response = await fetch(`${msw.hostProxyUrl}/shared`, {
        headers: { "x-test-case": caseId },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        caseId,
        seenHeader: caseId,
      });

      const seen = await msw.expectRequest({
        method: "GET",
        pathname: "/shared",
      });
      expect(seen.request.headers.get("x-test-case")).toBe(caseId);
      expect(msw.listRequests("match")).toHaveLength(1);
      msw.expectNoUnhandledRequests();
    });
  }

  for (const caseId of concurrentCaseIds.slice(0, 4)) {
    test.concurrent(`late-bound handlers stay isolated (${caseId})`, async () => {
      await using msw = await mswProxyFixture({ onUnhandledRequest: "error" });
      const path = "/late-bind";

      await delay(Math.floor(Math.random() * 40));
      msw.use(
        http.get(`https://upstream.iterate.localhost${path}`, () => {
          return HttpResponse.json({ caseId });
        }),
      );

      const response = await fetch(`${msw.hostProxyUrl}${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ caseId });
      msw.expectNoUnhandledRequests();
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

  test("late-bound MSW handler + curl prove caddy MITM + iptables REDIRECT egress flow", async () => {
    await using msw = await mswProxyFixture({
      onUnhandledRequest: "bypass",
    });

    await using container = await dockerContainerFixture({
      image,
      name: `jonasland2-e2e-${randomUUID()}`,
      env: {
        ITERATE_EXTERNAL_EGRESS_PROXY: msw.proxyUrl,
      },
      exposedPorts: ["80/tcp", "443/tcp", "2019/tcp"],
      extraHosts: ["host.docker.internal:host-gateway", "upstream.iterate.localhost:203.0.113.10"],
      capAdd: ["NET_ADMIN"],
    });

    const caddyHttpPort = await container.publishedPort("80/tcp");
    const caddyAdminPort = await container.publishedPort("2019/tcp");
    await waitForHealthyWithLogs(`http://127.0.0.1:${String(caddyHttpPort)}/healthz`, container);

    msw.use(
      http.get("https://upstream.iterate.localhost/from-curl", ({ request }) => {
        return HttpResponse.json({
          ok: true,
          path: new URL(request.url).pathname,
        });
      }),
    );

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

    const request = await msw.expectRequest({
      method: "GET",
      pathname: "/from-curl",
    });
    expect(request.request.headers.get("x-from-container")).toBe("yes");
    expect(request.request.headers.get("x-egress-proxy-seen")).toBe("1");
    msw.expectNoUnhandledRequests({
      url: (url) => url.hostname === "upstream.iterate.localhost",
    });

    const caddyAdminResponse = await fetch(`http://127.0.0.1:${String(caddyAdminPort)}/config/`);
    expect(caddyAdminResponse.ok).toBe(true);

    const nomad = await execInContainer({
      containerId: container.containerId,
      cmd: ["sh", "-lc", "command -v nomad >/dev/null && echo yes || echo no"],
    });
    expect(nomad.exitCode).toBe(0);
    expect(nomad.output.trim()).toBe("no");
  }, 120_000);

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
