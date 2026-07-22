// Deployed Firecracker proof; local fixtures are not container-reachable.

import type { RpcStub } from "capnweb";
import { expect, test } from "vitest";
import { z } from "zod";
import {
  annotateE2ePhase,
  measureE2ePhase,
} from "@iterate-com/shared/test-support/measure-e2e-phase";
import type { Project } from "../../src/itx-api.generated.ts";
import {
  SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS,
  SCRIPT_EXTERNAL_CLEANUP_GRACE_MS,
} from "../../src/domains/capability-host/script-execution-budgets.ts";
import { ScriptExecutionSettlement } from "../../src/domains/capability-host/script-execution-settlement.ts";
import type { SandboxLiteDurableObject } from "../../src/domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts";
import { createTestProject } from "../test-support/create-test-project.ts";
import { defineItxScript } from "../test-support/itx-script-builder.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, deployedBaseUrl, withItxSession } from "./test-helpers.ts";

// The proof needs enough real execution time to start the process group and
// hit its capped timeout, plus both production cleanup/settlement reserves. It
// does not need the old 30-second command ceiling: fifteen seconds leaves room
// for observed dynamic-worker startup and exercises the identical deadline
// path while keeping ordinary preview variance out of it.
const SCRIPT_DEADLINE_HORIZON_MS = 45_000;
const SCRIPT_SANDBOX_EXECUTION_BUDGET_CEILING_MS =
  SCRIPT_DEADLINE_HORIZON_MS -
  SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS -
  SCRIPT_EXTERNAL_CLEANUP_GRACE_MS;
const SandboxDeadlineResult = z.object({
  timedOut: z.object({
    exitCode: z.literal(124),
    stderr: z.string(),
    success: z.literal(false),
  }),
});

test(
  "a timed-out sandbox command terminates its entire process group",
  { timeout: 180_000 },
  async ({ annotate }) => {
    const measurePhase = <Value>(name: string, category: string, operation: () => Promise<Value>) =>
      measureE2ePhase(annotate, name, category, operation);
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = await measurePhase("create test project", "fixture", () =>
      itx.projects.get(`sandbox-timeout-${crypto.randomUUID()}`).create({}),
    );

    const sandboxPath = `/sandboxes/timeout-proof-${crypto.randomUUID()}`;
    await measurePhase("create lite sandbox", "fixture", () =>
      project.sandboxes.get(sandboxPath).create({
        instanceType: "lite",
      }),
    );
    const sandbox = (await project.sandboxes.get(
      sandboxPath,
    )) as unknown as RpcStub<SandboxLiteDurableObject>;
    const pidFile = `/tmp/timeout-proof-${crypto.randomUUID()}.pids`;

    try {
      // The process-group leader accepts SIGTERM while its child ignores it.
      // A timeout implementation that checks only the leader can therefore
      // report success while the child keeps executing. Redirect the child
      // away from the leader's capture pipes so that bug is observed as a
      // survivor instead of merely hanging the RPC forever.
      const timedOut = await measurePhase("run command through sandbox timeout", "operation", () =>
        sandbox.exec(
          [
            `pid_file=${shellSingleQuote(pidFile)}`,
            "(trap '' TERM; while :; do sleep 60; done) >/dev/null 2>&1 &",
            "child=$!",
            'printf \'%s %s\\n\' "$$" "$child" > "$pid_file"',
            "while :; do sleep 60; done",
          ].join("\n"),
          { timeout: 250 },
        ),
      );

      expect(timedOut).toMatchObject({ exitCode: 124, success: false });
      expect(timedOut.stderr).toContain("Command timed out after 250ms");

      const processProbe = await measurePhase(
        "verify timed-out processes exited",
        "verification",
        () =>
          sandbox.exec(
            [
              `pid_file=${shellSingleQuote(pidFile)}`,
              'test -s "$pid_file"',
              "active=''",
              "details=''",
              'for pid in $(cat "$pid_file"); do',
              '  row=$(ps -o pid=,ppid=,pgid=,stat=,args= -p "$pid")',
              '  test -n "$row" || continue',
              '  details="$details\\n$row"',
              '  state=$(ps -o stat= -p "$pid" | tr -d " ")',
              '  case "$state" in Z*) ;; *) active="$active $pid" ;; esac',
              "done",
              'if test -n "$active"; then printf "active survivors:%s\\nprocess table:%b\\n" "$active" "$details" >&2; exit 1; fi',
              "printf processes-gone",
            ].join("\n"),
            { timeout: 10_000 },
          ),
      );
      expect(processProbe, processProbe.stderr).toMatchObject({
        exitCode: 0,
        stdout: "processes-gone",
      });

      // Killing one command must leave the sandbox itself healthy.
      const followUp = await measurePhase("verify sandbox remains usable", "verification", () =>
        sandbox.exec("printf sandbox-usable", { timeout: 10_000 }),
      );
      expect(followUp, followUp.stderr).toMatchObject({
        exitCode: 0,
        stdout: "sandbox-usable",
      });
    } finally {
      await measurePhase("destroy sandbox", "cleanup", () => sandbox.destroy()).catch(() => {});
    }
  },
);

test.skipIf(deployedBaseUrl() === null)(
  "runScript caps an in-script sandbox timeout to its absolute deadline and kills the process group",
  { timeout: 90_000 },
  async ({ annotate }) => {
    const measurePhase = <Value>(name: string, category: string, operation: () => Promise<Value>) =>
      measureE2ePhase(annotate, name, category, operation);
    await using handle = await measurePhase("create test project", "fixture", () =>
      createTestProject({ slugPrefix: "script-sandbox-deadline" }),
    );
    using itx = handle.itx();
    using agent = handle.agent("/agents/script-sandbox-deadline");
    // Agent and capability-host processors have explicit births. A raw stream
    // append on an unborn path is intentionally inert, so create through the
    // public agent door before exercising the capability host.
    await measurePhase("create script agent", "fixture", () => agent.create());
    const sandboxName = `script-timeout-${crypto.randomUUID()}`;
    const sandboxPath = `/sandboxes/${sandboxName}`;
    await measurePhase("create lite sandbox", "fixture", () =>
      itx.sandboxes.get(sandboxPath).create({
        instanceType: "lite",
      }),
    );
    const sandbox = (await itx.sandboxes.get(
      sandboxPath,
    )) as unknown as RpcStub<SandboxLiteDurableObject>;
    const pidFile = `/tmp/script-timeout-${crypto.randomUUID()}.pids`;

    try {
      // Warm the container before starting the short absolute script budget;
      // the assertion below is about the generated runScript proxy, not cold
      // container boot variance.
      const warm = await measurePhase("warm sandbox container", "fixture", () =>
        sandbox.exec("printf warm", { timeout: 10_000 }),
      );
      expect(warm).toMatchObject({ exitCode: 0, stdout: "warm" });

      const executionId = `sandbox-deadline:${crypto.randomUUID()}`;
      const requestedAt = Date.now();
      const expiresAt = requestedAt + SCRIPT_DEADLINE_HORIZON_MS;
      await annotateE2ePhase(annotate, {
        name: "configured absolute script horizon",
        category: "configured-deadline",
        durationMs: SCRIPT_DEADLINE_HORIZON_MS,
      });
      await annotateE2ePhase(annotate, {
        name: "configured sandbox command budget ceiling",
        category: "configured-budget",
        durationMs: SCRIPT_SANDBOX_EXECUTION_BUDGET_CEILING_MS,
      });
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
      await measurePhase("append script run request", "operation", () =>
        agent.append({
          type: "events.iterate.com/capability-host/script-run-requested",
          payload: { code, executionId, expiresAt },
        }),
      );

      let settlement: unknown;
      let observedLifecycle: { offset: number; type: string }[] = [];
      await measurePhase("wait for deadline-bounded script settlement", "script-execution", () =>
        waitForCondition(
          async () => {
            const lifecycle = await agent.stream.getEvents({
              eventTypes: [
                "events.iterate.com/capability-host/script-run-started",
                "events.iterate.com/capability-host/script-run-settled",
              ],
              limit: 100,
            });
            observedLifecycle = lifecycle
              .filter((event) => event.payload?.executionId === executionId)
              .map((event) => ({ offset: event.offset, type: event.type }));
            const completion = lifecycle.find(
              (event) =>
                event.type === "events.iterate.com/capability-host/script-run-settled" &&
                event.payload?.executionId === executionId,
            );
            if (completion === undefined) return false;
            settlement = completion.payload?.settlement;
            return true;
          },
          {
            description: () =>
              `the deadline-bounded sandbox script to settle; observed lifecycle ${JSON.stringify(observedLifecycle)}`,
            intervalMs: 1_000,
            timeoutMs: 60_000,
          },
        ),
      );

      const parsed = ScriptExecutionSettlement.parse(settlement);
      expect(parsed, JSON.stringify(parsed)).toMatchObject({ status: "succeeded" });
      if (parsed.status !== "succeeded") throw new Error(parsed.error);
      const result = SandboxDeadlineResult.parse(parsed.result);
      const forwardedTimeoutMatch = /Command timed out after (\d+)ms/u.exec(result.timedOut.stderr);
      expect(
        forwardedTimeoutMatch,
        `sandbox timeout stderr did not report the forwarded timeout: ${result.timedOut.stderr}`,
      ).not.toBeNull();
      if (forwardedTimeoutMatch === null) throw new Error("missing forwarded sandbox timeout");
      const forwardedTimeoutMs = Number(forwardedTimeoutMatch[1]);
      expect(forwardedTimeoutMs).toBeGreaterThan(0);
      expect(forwardedTimeoutMs).toBeLessThanOrEqual(SCRIPT_SANDBOX_EXECUTION_BUDGET_CEILING_MS);
      await annotateE2ePhase(annotate, {
        name: "forwarded sandbox command timeout",
        category: "remaining-budget",
        durationMs: forwardedTimeoutMs,
      });
      await annotateE2ePhase(annotate, {
        name: "pre-command script budget consumed",
        category: "derived-overhead",
        durationMs: SCRIPT_SANDBOX_EXECUTION_BUDGET_CEILING_MS - forwardedTimeoutMs,
      });

      const processProbe = await measurePhase(
        "verify script processes exited",
        "verification",
        () =>
          sandbox.exec(
            [
              `pid_file=${shellSingleQuote(pidFile)}`,
              'test -s "$pid_file"',
              "active=''",
              "details=''",
              'for pid in $(cat "$pid_file"); do',
              '  row=$(ps -o pid=,ppid=,pgid=,stat=,args= -p "$pid")',
              '  test -n "$row" || continue',
              '  details="$details\\n$row"',
              '  state=$(ps -o stat= -p "$pid" | tr -d " ")',
              '  case "$state" in Z*) ;; *) active="$active $pid" ;; esac',
              "done",
              'if test -n "$active"; then printf "active survivors:%s\\nprocess table:%b\\n" "$active" "$details" >&2; exit 1; fi',
              "printf processes-gone",
            ].join("\n"),
            { timeout: 10_000 },
          ),
      );
      expect(processProbe, processProbe.stderr).toMatchObject({
        exitCode: 0,
        stdout: "processes-gone",
      });
    } finally {
      await measurePhase("destroy sandbox", "cleanup", () => sandbox.destroy()).catch(() => {});
    }
  },
);

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
