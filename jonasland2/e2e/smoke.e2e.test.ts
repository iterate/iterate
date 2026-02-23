import { randomUUID } from "node:crypto";
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

describe.runIf(await dockerPing())("jonasland2 minimal egress", () => {
  test("late-bound MSW handler + curl in container prove mocked egress response", async () => {
    await using msw = await mswProxyFixture({
      onUnhandledRequest: "bypass",
    });

    await using container = await dockerContainerFixture({
      image,
      name: `jonasland2-e2e-${randomUUID()}`,
      env: {
        ITERATE_EXTERNAL_EGRESS_PROXY: msw.proxyUrl,
      },
      exposedPorts: ["19000/tcp"],
      extraHosts: ["host.docker.internal:host-gateway"],
    });

    const egressPort = await container.publishedPort("19000/tcp");
    await waitForHttpOk(`http://127.0.0.1:${String(egressPort)}/healthz`);

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
      cmd: ["curl", "-sS", "-i", "-H", "x-from-container: yes", "http://127.0.0.1:19000/from-curl"],
    });
    expect(curl.exitCode).toBe(0);
    expect(curl.output).toContain("HTTP/1.1 200 OK");
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

    const nomad = await execInContainer({
      containerId: container.containerId,
      cmd: ["sh", "-lc", "command -v nomad >/dev/null && echo yes || echo no"],
    });

    expect(nomad.exitCode).toBe(0);
    expect(nomad.output.trim()).toBe("no");
  }, 120_000);

  test("websockets are proxied through egress and upstream sees proxy header", async () => {
    await using wsUpstream = await webSocketEchoServerFixture();

    await using container = await dockerContainerFixture({
      image,
      name: `jonasland2-e2e-ws-${randomUUID()}`,
      env: {
        ITERATE_EXTERNAL_EGRESS_PROXY: wsUpstream.url,
      },
      exposedPorts: ["19000/tcp"],
      extraHosts: ["host.docker.internal:host-gateway"],
    });

    const egressPort = await container.publishedPort("19000/tcp");
    await waitForHttpOk(`http://127.0.0.1:${String(egressPort)}/healthz`);

    const wsClient = await execInContainer({
      containerId: container.containerId,
      cmd: [
        "node",
        "-e",
        "const ws=new WebSocket('ws://127.0.0.1:19000/ws-check');const t=setTimeout(()=>{console.error('timeout');process.exit(1)},6000);ws.addEventListener('open',()=>ws.send('hello'));ws.addEventListener('message',(e)=>{console.log(String(e.data));ws.close();});ws.addEventListener('close',()=>{clearTimeout(t);process.exit(0)});ws.addEventListener('error',(e)=>{console.error(String(e?.message||'ws-error'));clearTimeout(t);process.exit(1)});",
      ],
    });
    expect(wsClient.exitCode).toBe(0);
    expect(wsClient.output).toContain("echo:hello");

    const handshake = await wsUpstream.waitForHandshake({ pathname: "/ws-check" });
    expect(handshake.headers["x-egress-proxy-seen"]).toBe("1");
    expect(handshake.headers["x-egress-mode"]).toBe("external-proxy");
  }, 120_000);
});
