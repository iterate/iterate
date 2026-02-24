import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { mockEgressProxy, projectDeployment } from "../test-helpers/index.ts";

const RUN_E2E = process.env.RUN_JONASLAND_E2E === "true";
const image = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland5-sandbox:local";

describe.runIf(RUN_E2E)("jonasland5 smoke", () => {
  test("caddy admin is API-only and typed caddy client works", async () => {
    await using deployment = await projectDeployment({
      image,
      name: `jonasland5-e2e-${randomUUID()}`,
    });

    await deployment.waitForHealthyWithLogs({ url: `${await deployment.ingressUrl()}/` });

    const rejectResult = await deployment.exec(
      "code=$(curl -sS -o /tmp/j5-admin-reject.json -w '%{http_code}' -H 'Host: caddy-admin.iterate.localhost' -H 'Sec-Fetch-Mode: navigate' http://127.0.0.1/config/ || true); echo \"$code\"; cat /tmp/j5-admin-reject.json",
    );
    expect(rejectResult.exitCode).toBe(0);
    expect(rejectResult.output).toContain("403");
    expect(rejectResult.output).toContain("client is not allowed to access from origin");

    const config = await deployment.caddy.getConfig();
    expect(config).toBeTypeOf("object");
  });

  test("fixture returns typed pidnap/caddy/services clients", async () => {
    await using deployment = await projectDeployment({
      image,
      name: `jonasland5-e2e-${randomUUID()}`,
    });

    await deployment.waitForPidnapHostRoute({});
    await deployment.assertIptablesRedirect();

    const managerStatus = await deployment.pidnap.manager.status();
    expect(managerStatus.state).toBe("running");

    const discoveryHost = `fixture-${randomUUID().slice(0, 8)}.iterate.localhost`;
    const upsert = await deployment.services.routes.upsert({
      host: discoveryHost,
      target: "127.0.0.1:9876",
      metadata: { source: "e2e" },
    });
    expect(upsert.route.host).toBe(discoveryHost);

    const load = await deployment.services.routes.caddyLoadInvocation({
      adminUrl: await deployment.ingressUrl(),
      apply: false,
    });
    expect(load.invocation.path).toBe("/load");
    expect(load.routeCount).toBeGreaterThan(0);

    const removed = await deployment.services.routes.remove({
      host: discoveryHost,
    });
    expect(removed.removed).toBe(true);
  });

  test("events service is reachable through caddy and supports CRUD", async () => {
    await using deployment = await projectDeployment({
      image,
      name: `jonasland5-e2e-events-${randomUUID()}`,
    });

    const health = await deployment.exec(
      "curl -fsS -H 'Host: events.iterate.localhost' http://127.0.0.1/healthz",
    );
    expect(health.exitCode).toBe(0);
    expect(health.output.trim()).toBe("ok");

    const createResult = await deployment.exec(
      'curl -fsS -H \'Host: events.iterate.localhost\' -H \'content-type: application/json\' --data \'{"type":"smoke-event","payload":{"source":"e2e"}}\' http://127.0.0.1/api/events',
    );
    expect(createResult.exitCode).toBe(0);
    const created = JSON.parse(createResult.output) as { id: string; type: string };
    expect(created.type).toBe("smoke-event");
    expect(created.id.length).toBeGreaterThan(0);

    const listResult = await deployment.exec(
      "curl -fsS -H 'Host: events.iterate.localhost' 'http://127.0.0.1/api/events?limit=20&offset=0'",
    );
    expect(listResult.exitCode).toBe(0);
    const listed = JSON.parse(listResult.output) as {
      total: number;
      events: Array<{ id: string }>;
    };
    expect(listed.total).toBeGreaterThan(0);
    expect(listed.events.some((event) => event.id === created.id)).toBe(true);
  });

  test("services sqlite state persists across container restart", async () => {
    await using deployment = await projectDeployment({
      image,
      name: `jonasland5-e2e-persist-${randomUUID()}`,
    });

    const routeHost = `persist-${randomUUID().slice(0, 8)}.iterate.localhost`;
    await deployment.services.routes.upsert({
      host: routeHost,
      target: "127.0.0.1:19010",
      metadata: { source: "persistence-test" },
      tags: ["caddy"],
    });
    await deployment.services.config.set({
      key: "caddy.adminUrl",
      value: "http://127.0.0.1:2019",
    });

    await deployment.restart();

    const routes = await deployment.services.routes.list({});
    expect(routes.routes.some((route) => route.host === routeHost)).toBe(true);

    const config = await deployment.services.config.get({
      key: "caddy.adminUrl",
    });
    expect(config.found).toBe(true);
    expect(config.entry?.value).toBe("http://127.0.0.1:2019");
  });

  test("pidnap can imperatively add and control a process", async () => {
    await using deployment = await projectDeployment({
      image,
      name: `jonasland5-e2e-${randomUUID()}`,
    });

    await deployment.waitForPidnapProcessRunning({
      target: "caddy",
      timeoutMs: 30_000,
    });

    const runtimeProcessName = `e2e-runtime-${randomUUID().slice(0, 8)}`;
    try {
      await deployment.pidnap.processes.add({
        name: runtimeProcessName,
        definition: {
          command: "sh",
          args: ["-ec", "trap : TERM INT; while :; do sleep 1; done"],
        },
        options: {
          restartPolicy: "always",
        },
        tags: ["e2e-runtime"],
      });
      await deployment.waitForPidnapProcessRunning({
        target: runtimeProcessName,
        timeoutMs: 30_000,
      });

      const stopResult = await deployment.pidnap.processes.stop({
        target: runtimeProcessName,
      });
      expect(stopResult.state).toBe("stopped");

      await deployment.pidnap.processes.start({ target: runtimeProcessName });
      await deployment.waitForPidnapProcessRunning({
        target: runtimeProcessName,
        timeoutMs: 30_000,
      });
    } finally {
      await deployment.pidnap.processes.remove({ target: runtimeProcessName }).catch(() => {});
    }
  });

  test("tls mitm to real upstream host via caddy -> egress-proxy chain", async () => {
    await using proxy = await mockEgressProxy();
    proxy.fetch = async (request) => {
      if (new URL(request.url).pathname === "/v1/models") {
        return Response.json({
          ok: true,
          path: new URL(request.url).pathname,
        });
      }
      return new Response("unmatched", { status: 599 });
    };

    const matched = proxy.waitFor((request) => new URL(request.url).pathname === "/v1/models");

    await using deployment = await projectDeployment({
      image,
      name: `jonasland5-e2e-egress-${randomUUID()}`,
      extraHosts: ["host.docker.internal:host-gateway"],
      env: {
        ITERATE_EXTERNAL_EGRESS_PROXY: proxy.proxyUrl,
      },
    });

    const curl = await deployment.exec(
      "curl -4 -k -sS -i -H 'x-from-container: yes' https://api.openai.com/v1/models",
    );

    expect(curl.exitCode).toBe(0);
    expect(curl.output).toMatch(/HTTP\/\d(?:\.\d)? 200/);
    expect(curl.output).toContain('{"ok":true,"path":"/v1/models"}');
    expect(curl.output.toLowerCase()).toContain("x-egress-proxy-seen: 1");
    expect(curl.output.toLowerCase()).toContain("x-egress-mode: external-proxy");

    const matchedRecord = await matched;
    expect(matchedRecord.response.status).toBe(200);
    expect(matchedRecord.request.headers.get("x-from-container")).toBe("yes");

    const unmatchedCount = proxy.records.filter((record) => record.response.status === 599).length;
    expect(unmatchedCount).toBe(0);
  });
});
