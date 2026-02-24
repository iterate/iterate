import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import {
  dockerContainerFixture,
  dockerPing,
  execInContainer,
  waitForHttpOk,
} from "../lib/fixtures.ts";

const RUN_E2E = process.env.RUN_JONASLAND_E2E === "true";
const image = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland3-sandbox:local";

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

async function waitForDynamicSrv(containerId: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const proxiedLeader = await execInContainer({
      containerId,
      cmd: ["sh", "-ec", "curl -fsS -H 'Host: nomad.localhost' http://127.0.0.1/v1/status/leader"],
    }).catch(() => ({ exitCode: 1, output: "" }));
    if (proxiedLeader.exitCode === 0 && proxiedLeader.output.trim().includes(":4647")) {
      return;
    }
    await delay(150);
  }
  throw new Error("timed out waiting for dynamic srv route to nomad");
}

describe.runIf(RUN_E2E && (await dockerPing()))("jonasland3 smoke", () => {
  test("caddy admin is API-only: browser-style navigate is rejected", async () => {
    await using container = await dockerContainerFixture({
      image,
      name: `jonasland3-e2e-${randomUUID()}`,
      exposedPorts: ["80/tcp", "4646/tcp", "8500/tcp", "8501/tcp"],
      capAdd: ["SYS_ADMIN"],
      cgroupnsMode: "host",
      binds: ["/sys/fs/cgroup:/sys/fs/cgroup:rw"],
    });

    const caddyHttpPort = await container.publishedPort("80/tcp");
    await waitForHealthyWithLogs(`http://127.0.0.1:${String(caddyHttpPort)}/`, container);
    const rejectResult = await execInContainer({
      containerId: container.containerId,
      cmd: [
        "sh",
        "-ec",
        "code=$(curl -sS -o /tmp/j3-admin-reject.json -w '%{http_code}' -H 'Sec-Fetch-Mode: navigate' http://127.0.0.1:2019/config/ || true); echo \"$code\"; cat /tmp/j3-admin-reject.json",
      ],
    });
    expect(rejectResult.exitCode).toBe(0);
    expect(rejectResult.output).toContain("403");
    expect(rejectResult.output).toContain("client is not allowed to access from origin");

    const apiResult = await execInContainer({
      containerId: container.containerId,
      cmd: ["sh", "-ec", "curl -fsS http://127.0.0.1:2019/config/ >/dev/null"],
    });
    expect(apiResult.exitCode).toBe(0);
  }, 120_000);

  test("nomad + consul + caddy are healthy and dynamic srv routing works", async () => {
    await using container = await dockerContainerFixture({
      image,
      name: `jonasland3-e2e-${randomUUID()}`,
      exposedPorts: ["80/tcp", "4646/tcp", "8500/tcp", "8501/tcp"],
      capAdd: ["SYS_ADMIN"],
      cgroupnsMode: "host",
      binds: ["/sys/fs/cgroup:/sys/fs/cgroup:rw"],
    });

    const nomadPort = await container.publishedPort("4646/tcp");
    const consulPort = await container.publishedPort("8500/tcp");
    const caddyHttpPort = await container.publishedPort("80/tcp");
    const cpmPort = await container.publishedPort("8501/tcp");

    await waitForHealthyWithLogs(`http://127.0.0.1:${String(caddyHttpPort)}/`, container);
    await waitForHealthyWithLogs(
      `http://127.0.0.1:${String(nomadPort)}/v1/status/leader`,
      container,
    );
    await waitForHealthyWithLogs(
      `http://127.0.0.1:${String(consulPort)}/v1/status/leader`,
      container,
    );
    await waitForHealthyWithLogs(`http://127.0.0.1:${String(cpmPort)}/`, container);
    await waitForDynamicSrv(container.containerId);

    const cpmUiResponse = await fetch(`http://127.0.0.1:${String(cpmPort)}/`);
    expect(cpmUiResponse.ok).toBe(true);
    const cpmUiBody = await cpmUiResponse.text();
    expect(cpmUiBody.length).toBeGreaterThan(200);

    const caddyAdmin = await execInContainer({
      containerId: container.containerId,
      cmd: ["sh", "-ec", "curl -fsS http://127.0.0.1:2019/config/ >/dev/null"],
    });
    expect(caddyAdmin.exitCode).toBe(0);

    const consulServices = await fetch(
      `http://127.0.0.1:${String(consulPort)}/v1/catalog/services`,
    );
    expect(consulServices.ok).toBe(true);
    const services = (await consulServices.json()) as Record<string, unknown>;
    expect("consul" in services).toBe(true);
    expect("nomad" in services).toBe(true);
    expect("caddy" in services).toBe(true);
  }, 120_000);
});
