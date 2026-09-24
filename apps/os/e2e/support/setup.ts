// e2e/support/setup.ts — per-file setup (setupFiles): resolve the one worker's URL, admin bearer and
// sign-in password (provided by global-setup) into the env vars the client helper reads, and dispose
// each test's capnweb sessions afterwards (sessions left open at teardown turn into
// unhandled-rejection noise — the cloudflare-os lesson).

import { e2eRowTimeoutCeilingMs } from "@iterate-com/shared/test-support/e2e-policy";
import { afterAll, afterEach, beforeEach, inject } from "vitest";
import { disposeFileSessions, disposeSessions, enterTestTransports } from "./client.ts";

process.env.WORKER_BASE_URL = inject("workerBaseUrl");
process.env.ADMIN_API_SECRET = inject("adminApiSecret");
process.env.LOGIN_PASSWORD = inject("loginPassword");
process.env.PROJECT_INGRESS_ROUTING = inject("ingressRouting");
process.env.MCP_BASE_URL = inject("mcpBaseUrl");
// The run's id, the same in every worker process: client.ts folds it into every identifier a test mints.
process.env.E2E_RUN_ID = inject("runId");

// The tests in a file run CONCURRENTLY (vitest.config.ts `sequence.concurrent`), so each one owns the
// sessions it opens: this hook enters that test's store (client.ts), and the afterEach below disposes
// that store alone — never a sibling still on the wire. It is the FIRST beforeEach: vitest awaits
// each hook in turn, and a store entered after the first await never reaches the test (2026-09-24, a
// hook registered above it: 206 rows shared one store, and the first to finish shut every sibling's
// session).
beforeEach(() => enterTestTransports());
afterEach(() => disposeSessions());
// What a file opened outside a test — a `beforeAll`, the benchmarks — belongs to the file.
afterAll(() => disposeFileSessions());

// THE ROW BUDGET, AT RUNTIME (docs/testing.md#the-row-budget): a run against a preview
// (`pnpm preview e2e`, which sets E2E_SLOW_ROWS) fails an e2e row whose timeout is over its ceiling
// before the row starts, since a hung row holds the whole run for its timeout.
// scripts/ci/e2e-policy.test.ts holds every row to the same ceiling from source; this catches a
// timeout it cannot read.
beforeEach(({ task }) => {
  if (!process.env.E2E_SLOW_ROWS || task.file.projectName !== "e2e") return;
  const ceilingMs = e2eRowTimeoutCeilingMs({ slow: task.tags?.includes("slow") ?? false });
  if (task.timeout > ceilingMs)
    throw new Error(
      `this row's timeout is ${task.timeout / 1000} s, over its ${ceilingMs / 1000} s ceiling: make it faster, or tag it "slow" if it waits out real platform time (docs/testing.md#the-row-budget)`,
    );
});
