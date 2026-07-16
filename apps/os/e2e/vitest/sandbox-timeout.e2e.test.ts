// Deployed Firecracker proof; local fixtures are not container-reachable.

import type { RpcStub } from "capnweb";
import { expect, test } from "vitest";
import type { Project } from "../../src/itx-api.generated.ts";
import { ScriptExecutionSettlement } from "../../src/domains/capability-host/script-execution-settlement.ts";
import type { SandboxLiteDurableObject } from "../../src/domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts";
import { createTestProject } from "../test-support/create-test-project.ts";
import { defineItxScript } from "../test-support/itx-script-builder.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, deployedBaseUrl, withItxSession } from "./test-helpers.ts";

test.skipIf(deployedBaseUrl() === null)(
  "a timed-out sandbox command terminates its entire process group",
  { timeout: 180_000 },
  async () => {
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = itx.projects.create({ slug: `sandbox-timeout-${crypto.randomUUID()}` });

    const { path: sandboxPath } = await project.sandboxes.create({
      instanceType: "lite",
      name: `timeout-proof-${crypto.randomUUID()}`,
    });
    const sandbox = (await project.sandboxes.get(
      sandboxPath,
    )) as unknown as RpcStub<SandboxLiteDurableObject>;
    const pidFile = `/tmp/timeout-proof-${crypto.randomUUID()}.pids`;

    try {
      // Both the process-group leader and its child ignore SIGTERM. This
      // forces the sessionless executor through its grace period and SIGKILL
      // path instead of allowing a cooperative parent exit to hide a live
      // descendant.
      const timedOut = await sandbox.exec(
        [
          `pid_file=${shellSingleQuote(pidFile)}`,
          "trap '' TERM",
          "(trap '' TERM; while :; do sleep 60; done) &",
          "child=$!",
          'printf \'%s %s\\n\' "$$" "$child" > "$pid_file"',
          "while :; do sleep 60; done",
        ].join("\n"),
        { timeout: 250 },
      );

      expect(timedOut).toMatchObject({ exitCode: 124, success: false });
      expect(timedOut.stderr).toContain("Command timed out after 250ms");

      const processProbe = await sandbox.exec(
        [
          `pid_file=${shellSingleQuote(pidFile)}`,
          'test -s "$pid_file"',
          "alive=''",
          'for pid in $(cat "$pid_file"); do if kill -0 "$pid" 2>/dev/null; then alive="$alive $pid"; fi; done',
          'if test -n "$alive"; then echo "survivors:$alive" >&2; exit 1; fi',
          "printf processes-gone",
        ].join("\n"),
        { timeout: 10_000 },
      );
      expect(processProbe, processProbe.stderr).toMatchObject({
        exitCode: 0,
        stdout: "processes-gone",
      });

      // Killing one command must leave the sandbox itself healthy.
      const followUp = await sandbox.exec("printf sandbox-usable", { timeout: 10_000 });
      expect(followUp, followUp.stderr).toMatchObject({
        exitCode: 0,
        stdout: "sandbox-usable",
      });
    } finally {
      await sandbox.destroy().catch(() => {});
    }
  },
);

test.skipIf(deployedBaseUrl() === null)(
  "runScript caps an in-script sandbox timeout to its absolute deadline and kills the process group",
  { timeout: 180_000 },
  async () => {
    await using handle = await createTestProject({ slugPrefix: "script-sandbox-deadline" });
    using itx = handle.itx();
    using agent = handle.agent("/agents/script-sandbox-deadline");
    const sandboxName = `script-timeout-${crypto.randomUUID()}`;
    const { path: sandboxPath } = await itx.sandboxes.create({
      instanceType: "lite",
      name: sandboxName,
    });
    const sandbox = (await itx.sandboxes.get(
      sandboxPath,
    )) as unknown as RpcStub<SandboxLiteDurableObject>;
    const pidFile = `/tmp/script-timeout-${crypto.randomUUID()}.pids`;

    try {
      // Warm the container before starting the short absolute script budget;
      // the assertion below is about the generated runScript proxy, not cold
      // container boot variance.
      const warm = await sandbox.exec("printf warm", { timeout: 10_000 });
      expect(warm).toMatchObject({ exitCode: 0, stdout: "warm" });

      const executionId = `sandbox-deadline:${crypto.randomUUID()}`;
      const expiresAt = Date.now() + 60_000;
      const { code } = defineItxScript(
        async (
          project: Project,
          vars: { pidFile: string; requestedTimeoutMs: number; sandboxPath: string },
        ) => {
          const guardedSandbox = (await project.sandboxes.get(vars.sandboxPath)) as unknown as {
            exec(
              command: string,
              options: { timeout: number },
            ): Promise<{ exitCode: number; stderr: string; success: boolean }>;
          };
          const quotedPidFile = `'${vars.pidFile.replaceAll("'", `'\\''`)}'`;
          const timedOut = await guardedSandbox.exec(
            [
              `pid_file=${quotedPidFile}`,
              "trap '' TERM",
              "(trap '' TERM; while :; do sleep 60; done) &",
              "child=$!",
              'printf \'%s %s\\n\' "$$" "$child" > "$pid_file"',
              "while :; do sleep 60; done",
            ].join("\n"),
            // The generated worker must replace this twenty-minute request
            // with the remaining absolute budget minus cleanup grace.
            { timeout: vars.requestedTimeoutMs },
          );
          return { timedOut };
        },
        { pidFile, requestedTimeoutMs: 20 * 60 * 1_000, sandboxPath },
      );
      await agent.stream.append({
        type: "events.iterate.com/capability-host/script-execution-requested",
        payload: { code, executionId, expiresAt },
      });

      let settlement: unknown;
      await waitForCondition(
        async () => {
          const completions = await agent.stream.getEvents({
            eventTypes: ["events.iterate.com/capability-host/script-execution-completed"],
            limit: 100,
          });
          const completion = completions.find(
            (event) => event.payload?.executionId === executionId,
          );
          if (completion === undefined) return false;
          settlement = completion.payload?.settlement;
          return true;
        },
        {
          description: "the deadline-bounded sandbox script to settle",
          intervalMs: 1_000,
          timeoutMs: 120_000,
        },
      );

      const parsed = ScriptExecutionSettlement.parse(settlement);
      expect(parsed).toMatchObject({ status: "succeeded" });
      if (parsed.status !== "succeeded") throw new Error(parsed.error);
      expect(parsed.result).toMatchObject({
        timedOut: {
          exitCode: 124,
          success: false,
        },
      });

      const processProbe = await sandbox.exec(
        [
          `pid_file=${shellSingleQuote(pidFile)}`,
          'test -s "$pid_file"',
          "alive=''",
          'for pid in $(cat "$pid_file"); do if kill -0 "$pid" 2>/dev/null; then alive="$alive $pid"; fi; done',
          'if test -n "$alive"; then echo "survivors:$alive" >&2; exit 1; fi',
          "printf processes-gone",
        ].join("\n"),
        { timeout: 10_000 },
      );
      expect(processProbe, processProbe.stderr).toMatchObject({
        exitCode: 0,
        stdout: "processes-gone",
      });
    } finally {
      await sandbox.destroy().catch(() => {});
    }
  },
);

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
