import { describe, expect, test } from "vitest";
import { FlyProvider } from "../providers/fly/provider.ts";
import { provisionSharedEgressAndAttach } from "../providers/fly/shared-egress.ts";
import { RUN_SANDBOX_TESTS, TEST_CONFIG } from "./helpers.ts";

const RUN_FLY_SHARED_EGRESS_TEST =
  RUN_SANDBOX_TESTS &&
  TEST_CONFIG.provider === "fly" &&
  process.env.RUN_FLY_SHARED_EGRESS_TESTS === "true";

function buildTestEnv(network: string, prefix: string): Record<string, string | undefined> {
  return {
    ...process.env,
    FLY_NETWORK: network,
    FLY_APP_PREFIX: prefix,
  };
}

async function deleteFlyMachine(
  env: Record<string, string | undefined>,
  appName: string,
  machineId: string,
): Promise<void> {
  const token = env.FLY_API_TOKEN;
  if (!token) return;

  await fetch(
    `https://api.machines.dev/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}?force=true`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    },
  ).catch(() => undefined);
}

async function deleteFlyApp(
  env: Record<string, string | undefined>,
  appName: string,
): Promise<void> {
  const token = env.FLY_API_TOKEN;
  if (!token) return;

  await fetch(`https://api.machines.dev/v1/apps/${encodeURIComponent(appName)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  }).catch(() => undefined);
}

describe.runIf(RUN_FLY_SHARED_EGRESS_TEST)("Fly shared egress", () => {
  test(
    "multiple sandboxes can share one egress machine",
    async () => {
      const suffix = Date.now().toString(36);
      const network = `iterate-fly-${suffix}-net`;
      const prefix = `iterate-fly-${suffix}`;
      const egressAppName = `${prefix}-egress`;
      const env = buildTestEnv(network, prefix);

      const provider = new FlyProvider(env);

      const sandboxA = await provider.create({
        id: `fly-a-${suffix}`,
        name: "Fly A",
        envVars: {},
        command: ["sleep", "infinity"],
      });

      const sandboxB = await provider.create({
        id: `fly-b-${suffix}`,
        name: "Fly B",
        envVars: {},
        command: ["sleep", "infinity"],
      });

      let egressMachineId: string | null = null;

      try {
        const attachA = await provisionSharedEgressAndAttach({
          env,
          network,
          egressAppName,
          sandbox: sandboxA,
          tunnelIp: "10.99.0.2",
          applyLockdownPolicy: true,
        });
        egressMachineId = attachA.egress.machineId;

        await provisionSharedEgressAndAttach({
          env,
          network,
          egressAppName,
          sandbox: sandboxB,
          tunnelIp: "10.99.0.3",
          applyLockdownPolicy: true,
        });

        const blocked = await sandboxA.exec([
          "/bin/bash",
          "-lc",
          "curl --interface eth0 --max-time 5 -s http://1.1.1.1 || echo BLOCKED",
        ]);
        expect(blocked).toContain("BLOCKED");

        const viaTunnelA = await sandboxA.exec([
          "/bin/bash",
          "-lc",
          "curl --max-time 15 -s -o /dev/null -w '%{http_code}' http://example.com",
        ]);
        expect(viaTunnelA.trim()).toContain("200");

        const viaTunnelB = await sandboxB.exec([
          "/bin/bash",
          "-lc",
          "curl --max-time 15 -s -o /dev/null -w '%{http_code}' http://example.com",
        ]);
        expect(viaTunnelB.trim()).toContain("200");
      } finally {
        await sandboxA.delete().catch(() => undefined);
        await sandboxB.delete().catch(() => undefined);

        if (egressMachineId) {
          await deleteFlyMachine(env, egressAppName, egressMachineId);
        }

        await deleteFlyApp(env, egressAppName);
      }
    },
    10 * 60 * 1000,
  );
});
