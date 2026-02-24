import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  dockerPing,
  loadCaddyConfigForMockUpstream,
  mockEgressProxy,
  projectDeployment,
} from "../test-helpers/index.ts";

const RUN_E2E = process.env.RUN_JONASLAND_E2E === "true";
const image = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland5-sandbox:local";

describe.runIf(RUN_E2E && (await dockerPing()))("jonasland5 smoke", () => {
  test.concurrent(
    "caddy admin is API-only and typed caddy client works",
    async () => {
      await using deployment = await projectDeployment({
        image,
        name: `jonasland5-e2e-${randomUUID()}`,
      });

      await deployment.waitForHealthyWithLogs({ url: `${await deployment.ingressUrl()}/` });

      const rejectResult = await deployment.exec({
        cmd: [
          "sh",
          "-ec",
          "code=$(curl -sS -o /tmp/j5-admin-reject.json -w '%{http_code}' -H 'Host: caddy-admin.iterate.localhost' -H 'Sec-Fetch-Mode: navigate' http://127.0.0.1/config/ || true); echo \"$code\"; cat /tmp/j5-admin-reject.json",
        ],
      });
      expect(rejectResult.exitCode).toBe(0);
      expect(rejectResult.output).toContain("403");
      expect(rejectResult.output).toContain("client is not allowed to access from origin");

      const config = await deployment.caddy.getConfig();
      expect(config).toBeTypeOf("object");
    },
    120_000,
  );

  test.concurrent(
    "fixture returns typed pidnap/caddy/services clients",
    async () => {
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
    },
    120_000,
  );

  test.concurrent(
    "pidnap can imperatively add and control a process",
    async () => {
      await using deployment = await projectDeployment({
        image,
        name: `jonasland5-e2e-${randomUUID()}`,
      });

      await deployment.waitForPidnapProcessRunning({
        target: "caddy",
        timeoutMs: 45_000,
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
    },
    120_000,
  );

  test.concurrent(
    "tls mitm to real upstream host via redirect + caddy load",
    async () => {
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
        extraHosts: ["host.docker.internal:host-gateway", "api.openai.com:203.0.113.10"],
      });

      await loadCaddyConfigForMockUpstream({
        caddyClient: deployment.caddy,
        upstreamDial: `host.docker.internal:${String(new URL(proxy.hostProxyUrl).port)}`,
        upstreamHost: "api.openai.com",
      });

      const curl = await deployment.exec({
        cmd: [
          "curl",
          "-k",
          "-sS",
          "-i",
          "-H",
          "x-from-container: yes",
          "https://api.openai.com/v1/models",
        ],
      });

      expect(curl.exitCode).toBe(0);
      expect(curl.output).toMatch(/HTTP\/\d(?:\.\d)? 200/);
      expect(curl.output).toContain('{"ok":true,"path":"/v1/models"}');

      const matchedRecord = await matched;
      expect(matchedRecord.response.status).toBe(200);
      expect(matchedRecord.request.headers.get("x-from-container")).toBe("yes");

      const unmatchedCount = proxy.records.filter(
        (record) => record.response.status === 599,
      ).length;
      expect(unmatchedCount).toBe(0);
    },
    120_000,
  );
});
