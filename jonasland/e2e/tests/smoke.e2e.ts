import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DockerDeployment, type DeploymentRuntime } from "@iterate-com/shared/jonasland/deployment";
import { mockEgressProxy } from "../test-helpers/mock-egress-proxy.ts";

const E2E_PROVIDER = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const RUN_DOCKER_E2E = E2E_PROVIDER === "docker";
const DOCKER_IMAGE = process.env.JONASLAND_E2E_DOCKER_IMAGE ?? "jonasland-sandbox:local";
const ITERATE_REPO = "/home/iterate/src/github.com/iterate/iterate";
const PIDNAP_TSX_PATH = `${ITERATE_REPO}/packages/pidnap/node_modules/.bin/tsx`;
const OTEL_SERVICE_ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
  OTEL_PROPAGATORS: "tracecontext,baggage",
};
type OnDemandProcessName = "orders" | "home" | "outerbase" | "egress-proxy" | "docs";
type OnDemandProcessConfig = {
  definition: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  routeCheck?: {
    host: string;
    path: string;
  };
  directHttpCheck?: {
    url: string;
  };
};

const ON_DEMAND_PROCESSES: Record<OnDemandProcessName, OnDemandProcessConfig> = {
  orders: {
    definition: {
      command: PIDNAP_TSX_PATH,
      args: [`${ITERATE_REPO}/services/orders-service/src/server.ts`],
      env: OTEL_SERVICE_ENV,
    },
    routeCheck: { host: "orders.iterate.localhost", path: "/api/service/health" },
  },
  home: {
    definition: {
      command: PIDNAP_TSX_PATH,
      args: [`${ITERATE_REPO}/services/home-service/src/server.ts`],
      env: OTEL_SERVICE_ENV,
    },
    routeCheck: { host: "home.iterate.localhost", path: "/" },
  },
  outerbase: {
    definition: {
      command: PIDNAP_TSX_PATH,
      args: [`${ITERATE_REPO}/services/outerbase-service/src/server.ts`],
      env: OTEL_SERVICE_ENV,
    },
    routeCheck: { host: "outerbase.iterate.localhost", path: "/healthz" },
  },
  "egress-proxy": {
    definition: {
      command: PIDNAP_TSX_PATH,
      args: [`${ITERATE_REPO}/services/egress-service/src/server.ts`],
      env: OTEL_SERVICE_ENV,
    },
    directHttpCheck: { url: "http://127.0.0.1:19000/healthz" },
  },
  docs: {
    definition: {
      command: PIDNAP_TSX_PATH,
      args: [`${ITERATE_REPO}/services/docs-service/src/server.ts`],
      env: OTEL_SERVICE_ENV,
    },
    routeCheck: { host: "docs.iterate.localhost", path: "/healthz" },
  },
};

async function waitForHostRoute(
  deployment: DeploymentRuntime,
  params: { host: string; path: string; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await deployment
      .exec(`curl -fsS -H 'Host: ${params.host}' 'http://127.0.0.1${params.path}' >/dev/null`)
      .catch(() => ({ exitCode: 1, output: "" }));
    if (result.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for host route ${params.host}${params.path}`);
}

async function waitForDirectHttp(
  deployment: DeploymentRuntime,
  params: { url: string; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await deployment
      .exec(`curl -fsS '${params.url}' >/dev/null`)
      .catch(() => ({ exitCode: 1, output: "" }));
    if (result.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for direct http ${params.url}`);
}

async function startOnDemandProcess(
  deployment: DeploymentRuntime,
  processName: OnDemandProcessName,
): Promise<void> {
  const processConfig = ON_DEMAND_PROCESSES[processName];
  const updated = await deployment.pidnap.processes.updateConfig({
    processSlug: processName,
    definition: processConfig.definition,
    options: { restartPolicy: "always" },
    envOptions: { reloadDelay: false },
  });
  if (updated.state !== "running") {
    await deployment.pidnap.processes.start({ target: processName });
  }
  await deployment.waitForPidnapProcessRunning({
    target: processName,
    timeoutMs: 45_000,
  });
  if (processConfig.routeCheck) {
    await waitForHostRoute(deployment, processConfig.routeCheck);
  }
  if (processConfig.directHttpCheck) {
    await waitForDirectHttp(deployment, processConfig.directHttpCheck);
  }
}

async function waitForDocsSources(
  deployment: DeploymentRuntime,
  expectedHosts: string[],
): Promise<{ sources: Array<{ id: string; title: string; specUrl: string }>; total: number }> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await deployment
      .exec("curl -fsS -H 'Host: docs.iterate.localhost' http://127.0.0.1/api/openapi-sources")
      .catch(() => ({ exitCode: 1, output: "" }));

    if (response.exitCode === 0) {
      try {
        const payload = JSON.parse(response.output) as {
          sources: Array<{ id: string; title: string; specUrl: string }>;
          total: number;
        };
        const ids = new Set(payload.sources.map((source) => source.id));
        const allPresent = expectedHosts.every((expectedHost) => ids.has(expectedHost));
        if (allPresent) {
          return payload;
        }
      } catch {
        // keep polling
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(`timed out waiting for docs sources: ${expectedHosts.join(", ")}`);
}

describe.runIf(RUN_DOCKER_E2E)("jonasland smoke", () => {
  test("caddy admin is API-only and typed caddy client works", async () => {
    await using deployment = await DockerDeployment.createWithConfig({
      dockerImage: DOCKER_IMAGE,
      name: `jonasland-e2e-${randomUUID()}`,
    }).create();

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

  test("home and outerbase host routes are reachable", async () => {
    await using deployment = await DockerDeployment.createWithConfig({
      dockerImage: DOCKER_IMAGE,
      name: `jonasland-e2e-home-outerbase-${randomUUID()}`,
    }).create();
    await startOnDemandProcess(deployment, "home");
    await startOnDemandProcess(deployment, "outerbase");

    const home = await deployment.exec(
      "curl -fsS -H 'Host: home.iterate.localhost' http://127.0.0.1/",
    );
    expect(home.exitCode).toBe(0);
    expect(home.output).toContain("jonasland");
    expect(home.output).toContain("Lightweight local browser index");

    const outerbase = await deployment.exec(
      "curl -fsS -H 'Host: outerbase.iterate.localhost' http://127.0.0.1/healthz",
    );
    expect(outerbase.exitCode).toBe(0);
    expect(outerbase.output).toContain('"ok":true');
  });

  test("fixture returns typed pidnap/caddy/registry client", async () => {
    await using deployment = await DockerDeployment.createWithConfig({
      dockerImage: DOCKER_IMAGE,
      name: `jonasland-e2e-${randomUUID()}`,
    }).create();

    await deployment.waitForPidnapHostRoute({});
    await deployment.assertIptablesRedirect();

    const managerStatus = await deployment.pidnap.manager.status();
    expect(managerStatus.state).toBe("running");

    const discoveryHost = `fixture-${randomUUID().slice(0, 8)}.iterate.localhost`;
    const upsert = await deployment.registry.routes.upsert({
      host: discoveryHost,
      target: "127.0.0.1:17300",
      metadata: { source: "e2e" },
    });
    expect(upsert.route.host).toBe(discoveryHost);

    const load = await deployment.registry.routes.caddyLoadInvocation({
      adminUrl: await deployment.ingressUrl(),
      apply: false,
    });
    expect(load.invocation.path).toBe("/load");
    expect(load.routeCount).toBeGreaterThan(0);

    const removed = await deployment.registry.routes.remove({
      host: discoveryHost,
    });
    expect(removed.removed).toBe(true);
  });

  test("events service is reachable through caddy and supports stream append/list", async () => {
    await using deployment = await DockerDeployment.createWithConfig({
      dockerImage: DOCKER_IMAGE,
      name: `jonasland-e2e-events-${randomUUID()}`,
    }).create();

    const health = await deployment.exec([
      "curl",
      "-fsS",
      "-H",
      "Host: events.iterate.localhost",
      "http://127.0.0.1/api/service/health",
    ]);
    expect(health.exitCode).toBe(0);
    const healthPayload = JSON.parse(health.output) as { ok: boolean; service: string };
    expect(healthPayload.ok).toBe(true);
    expect(healthPayload.service).toBe("jonasland-events-service");

    const streamPath = `smoke/events/${randomUUID().slice(0, 8)}`;
    const appendResult = await deployment.exec([
      "curl",
      "-fsS",
      "-H",
      "Host: events.iterate.localhost",
      "-H",
      "content-type: application/json",
      "--data",
      JSON.stringify({
        json: {
          path: streamPath,
          events: [
            {
              type: "https://events.iterate.com/events/test/smoke-event-recorded",
              payload: { source: "e2e" },
            },
          ],
        },
      }),
      "http://127.0.0.1/orpc/append",
    ]);
    expect(appendResult.exitCode).toBe(0);
    expect(appendResult.output).toBe("{}");

    const listResult = await deployment.exec([
      "curl",
      "-fsS",
      "-H",
      "Host: events.iterate.localhost",
      "-H",
      "content-type: application/json",
      "--data",
      JSON.stringify({ json: {} }),
      "http://127.0.0.1/orpc/listStreams",
    ]);
    expect(listResult.exitCode).toBe(0);
    const listed = JSON.parse(listResult.output) as {
      json: Array<{ path: string; eventCount: number }>;
    };
    expect(listed.json.some((entry) => entry.path === `/${streamPath}`)).toBe(true);
    expect(
      listed.json.some((entry) => entry.path === `/${streamPath}` && entry.eventCount >= 1),
    ).toBe(true);
  });

  test("orders service is reachable and emits order-placed stream events", async () => {
    await using deployment = await DockerDeployment.createWithConfig({
      dockerImage: DOCKER_IMAGE,
      name: `jonasland-e2e-orders-${randomUUID()}`,
    }).create();
    await startOnDemandProcess(deployment, "orders");

    const health = await deployment.exec(
      "curl -fsS -H 'Host: orders.iterate.localhost' http://127.0.0.1/healthz",
    );
    expect(health.exitCode).toBe(0);
    expect(health.output.trim()).toBe("ok");

    const placeResult = await deployment.exec(
      "curl -fsS -H 'Host: orders.iterate.localhost' -H 'content-type: application/json' --data '{\"sku\":\"sku-123\",\"quantity\":2}' http://127.0.0.1/api/orders",
    );
    expect(placeResult.exitCode).toBe(0);
    const placed = JSON.parse(placeResult.output) as {
      id: string;
      eventId: string;
      sku: string;
      quantity: number;
      status: string;
    };
    expect(placed.id.length).toBeGreaterThan(0);
    expect(placed.eventId.length).toBeGreaterThan(0);
    expect(placed.sku).toBe("sku-123");
    expect(placed.quantity).toBe(2);
    expect(placed.status).toBe("accepted");

    const findOrderResult = await deployment.exec(
      `curl -fsS -H 'Host: orders.iterate.localhost' 'http://127.0.0.1/api/orders/${placed.id}'`,
    );
    expect(findOrderResult.exitCode).toBe(0);
    const found = JSON.parse(findOrderResult.output) as { id: string; eventId: string };
    expect(found.id).toBe(placed.id);
    expect(found.eventId).toBe(placed.eventId);

    const streamResult = await deployment.exec(
      "curl -fsS -H 'Host: events.iterate.localhost' 'http://127.0.0.1/api/streams/orders'",
    );
    expect(streamResult.exitCode).toBe(0);
    expect(streamResult.output).toContain("https://events.iterate.com/orders/order-placed");
    expect(streamResult.output).toContain(placed.id);
    expect(streamResult.output).toContain(placed.eventId);
  });

  test("docs service consolidates OpenAPI specs from tagged services", async () => {
    await using deployment = await DockerDeployment.createWithConfig({
      dockerImage: DOCKER_IMAGE,
      name: `jonasland-e2e-docs-${randomUUID()}`,
    }).create();
    await startOnDemandProcess(deployment, "orders");
    await startOnDemandProcess(deployment, "docs");

    const docsHome = await deployment.exec(
      "curl -fsS -H 'Host: docs.iterate.localhost' http://127.0.0.1/",
    );
    expect(docsHome.exitCode).toBe(0);
    expect(docsHome.output).toContain("jonasland API Docs");

    const sourcesPayload = await deployment.waitForDocsSources([
      "events.iterate.localhost",
      "orders.iterate.localhost",
    ]);
    expect(sourcesPayload.total).toBeGreaterThanOrEqual(2);
    expect(
      sourcesPayload.sources.some(
        (source) =>
          source.id === "events.iterate.localhost" && source.specUrl.endsWith("/api/openapi.json"),
      ),
    ).toBe(true);
    expect(
      sourcesPayload.sources.some(
        (source) =>
          source.id === "orders.iterate.localhost" && source.specUrl.endsWith("/api/openapi.json"),
      ),
    ).toBe(true);

    const corsPreflight = await deployment.exec(
      "curl -sS -i -X OPTIONS -H 'Host: orders.iterate.localhost' -H 'Origin: http://docs.iterate.localhost' -H 'Access-Control-Request-Method: GET' http://127.0.0.1/api/openapi.json",
    );
    expect(corsPreflight.exitCode).toBe(0);
    expect(corsPreflight.output).toMatch(/HTTP\/\d(?:\.\d)? 204/);
    expect(corsPreflight.output.toLowerCase()).toContain(
      "access-control-allow-origin: http://docs.iterate.localhost",
    );
  });

  test("services sqlite WAL mode and state persist across container restart", async () => {
    await using deployment = await DockerDeployment.createWithConfig({
      dockerImage: DOCKER_IMAGE,
      name: `jonasland-e2e-persist-${randomUUID()}`,
    }).create();

    const readJournalMode = async () => {
      const result = await deployment.registry.service.sql({
        statement: "PRAGMA journal_mode;",
      });
      const firstRow = result.rows[0] ?? {};
      const value = Object.values(firstRow)[0];
      return String(value ?? "").toLowerCase();
    };

    const routeHost = `persist-${randomUUID().slice(0, 8)}.iterate.localhost`;
    await deployment.registry.routes.upsert({
      host: routeHost,
      target: "127.0.0.1:17320",
      metadata: { source: "persistence-test" },
      tags: ["caddy"],
    });
    await deployment.registry.config.set({
      key: "caddy.adminUrl",
      value: "http://127.0.0.1:2019",
    });

    const modeBeforeRestart = await readJournalMode();
    expect(modeBeforeRestart).toBe("wal");

    const sidecarsBeforeRestart = await deployment.exec(
      "test -f /var/lib/jonasland/registry.sqlite-wal && test -f /var/lib/jonasland/registry.sqlite-shm",
    );
    expect(sidecarsBeforeRestart.exitCode).toBe(0);

    await deployment.restart();

    const modeAfterRestart = await readJournalMode();
    expect(modeAfterRestart).toBe("wal");

    const routes = await deployment.registry.routes.list({});
    expect(routes.routes.some((route) => route.host === routeHost)).toBe(true);

    const config = await deployment.registry.config.get({
      key: "caddy.adminUrl",
    });
    expect(config.found).toBe(true);
    expect(config.entry?.value).toBe("http://127.0.0.1:2019");

    const sidecarsAfterRestart = await deployment.exec(
      "test -f /var/lib/jonasland/registry.sqlite-wal && test -f /var/lib/jonasland/registry.sqlite-shm",
    );
    expect(sidecarsAfterRestart.exitCode).toBe(0);
  });

  test("pidnap can imperatively add and control a process", async () => {
    await using deployment = await DockerDeployment.createWithConfig({
      dockerImage: DOCKER_IMAGE,
      name: `jonasland-e2e-${randomUUID()}`,
    }).create();

    await deployment.waitForPidnapProcessRunning({
      target: "caddy",
      timeoutMs: 30_000,
    });

    const runtimeProcessSlug = `e2e-runtime-${randomUUID().slice(0, 8)}`;
    try {
      await deployment.pidnap.processes.updateConfig({
        processSlug: runtimeProcessSlug,
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
        target: runtimeProcessSlug,
        timeoutMs: 30_000,
      });

      const stopResult = await deployment.pidnap.processes.stop({
        target: runtimeProcessSlug,
      });
      expect(stopResult.state).toBe("stopped");

      await deployment.pidnap.processes.start({ target: runtimeProcessSlug });
      await deployment.waitForPidnapProcessRunning({
        target: runtimeProcessSlug,
        timeoutMs: 30_000,
      });
    } finally {
      await deployment.pidnap.processes.delete({ processSlug: runtimeProcessSlug }).catch(() => {});
    }
  });

  test("tls mitm to real upstream host via caddy -> egress-proxy chain", async () => {
    await using proxy = await mockEgressProxy({
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/v1/models") {
          return Response.json({
            ok: true,
            path: new URL(request.url).pathname,
          });
        }
        return new Response("unmatched", { status: 599 });
      },
    });

    const matched = proxy.waitFor((request) => new URL(request.url).pathname === "/v1/models");

    await using deployment = await DockerDeployment.createWithConfig({
      dockerImage: DOCKER_IMAGE,
      name: `jonasland-e2e-egress-${randomUUID()}`,
      env: {
        ITERATE_EXTERNAL_EGRESS_PROXY: proxy.proxyUrl,
      },
    }).create();
    await startOnDemandProcess(deployment, "egress-proxy");

    const curl = await deployment.exec(
      "curl -4 -k -sS -i -H 'x-iterate-from-container: yes' https://api.openai.com/v1/models",
    );

    expect(curl.exitCode).toBe(0);
    expect(curl.output).toMatch(/HTTP\/\d(?:\.\d)? 200/);
    expect(curl.output).toContain('{"ok":true,"path":"/v1/models"}');
    expect(curl.output.toLowerCase()).toContain("x-iterate-egress-proxy-seen: 1");
    expect(curl.output.toLowerCase()).toContain("x-iterate-egress-mode: external-proxy");

    const matchedRecord = await matched;
    expect(matchedRecord.response.status).toBe(200);
    expect(matchedRecord.request.headers.get("x-iterate-from-container")).toBe("yes");

    const unmatchedCount = proxy.records.filter((record) => record.response.status === 599).length;
    expect(unmatchedCount).toBe(0);
  });

  test("egress supports x-iterate-target-url direct mode", async () => {
    await using proxy = await mockEgressProxy({
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/direct-target") {
          return Response.json({
            ok: true,
            path: new URL(request.url).pathname,
            mode: "direct-target",
          });
        }
        return new Response("unmatched", { status: 599 });
      },
    });

    const matched = proxy.waitFor((request) => new URL(request.url).pathname === "/direct-target");

    await using deployment = await DockerDeployment.createWithConfig({
      dockerImage: DOCKER_IMAGE,
      name: `jonasland-e2e-egress-direct-${randomUUID()}`,
    }).create();
    await startOnDemandProcess(deployment, "egress-proxy");

    const directTarget = `${proxy.proxyUrl}/direct-target`;
    const curl = await deployment.exec(
      `curl -4 -k -sS -i -H 'x-iterate-target-url: ${directTarget}' -H 'x-iterate-from-container: yes' https://example.com/ignore-this-path`,
    );

    expect(curl.exitCode).toBe(0);
    expect(curl.output).toMatch(/HTTP\/\d(?:\.\d)? 200/);
    expect(curl.output).toContain('{"ok":true,"path":"/direct-target","mode":"direct-target"}');
    expect(curl.output.toLowerCase()).toContain("x-iterate-egress-mode: direct");
    expect(curl.output.toLowerCase()).toContain("x-iterate-egress-proxy-seen: 1");

    const matchedRecord = await matched;
    expect(matchedRecord.response.status).toBe(200);
    expect(matchedRecord.request.headers.get("x-iterate-from-container")).toBe("yes");
  });
});
