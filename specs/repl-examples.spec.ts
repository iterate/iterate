import { expect } from "@playwright/test";
import { spinnerWaiter } from "middlewright";
import JSON5 from "json5";
import { EXAMPLE_CASES } from "../apps/os/e2e/examples/example-cases.ts";
import { ITX_EXAMPLES } from "../apps/os/src/itx/examples.ts";
import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

const REPL_EXAMPLES = Object.entries(EXAMPLE_CASES).flatMap(([id, exampleCase]) => {
  const example = ITX_EXAMPLES.find((candidate) => candidate.id === id);
  if (!example) throw new Error(`example-cases.ts references missing example ${id}`);
  // REPL Runs execute server-side as scope scripts, so entries needing a
  // live caller-owned session (live capability providers) carry no browser
  // runtime; the node/cli matrix proves those instead of this spec.
  if (!example.runtimes.includes("browser")) return [];
  return [{ example, exampleCase }];
});

test.describe("itx REPL catalogue examples", () => {
  for (const { example, exampleCase } of REPL_EXAMPLES) {
    test(`runs "${example.id}" through the project REPL`, async ({ baseURL, helpers, page }) => {
      // Cold-path examples declare their own completion budget (see
      // ExampleCase.completionTimeoutMs); the playwright test timeout must
      // not undercut it.
      if (exampleCase.completionTimeoutMs) {
        test.setTimeout(exampleCase.completionTimeoutMs + 60_000);
      }
      await using fixture = await helpers.createFixture(`repl-${example.id}`);
      await test.step("open project REPL", async () => {
        await page.goto(`/projects/${fixture.project.slug}/repl`);
        // exact: the project slug can contain "run", which substring-matches sidebar buttons
        await page.getByRole("button", { name: "Run", exact: true }).waitFor();
        page.videoMode?.setStartTime(); // start video from now
        await page.getByTestId("itx-repl-editor").locator(".cm-content").waitFor();
      });

      const ctx = {
        attemptSalt: crypto.randomUUID().slice(0, 8),
        marker: `playwright-${example.id}-${crypto.randomUUID().slice(0, 8)}`,
        projectId: fixture.project.id,
      };

      const entries = page.getByTestId("itx-repl-entry");
      const entryIndex = await entries.count();

      // In a FINALLY: failed attempts are exactly the ones whose resources
      // must not leak (a stuck sandbox container from a timed-out attempt
      // keeps holding slot capacity while the retry mints a fresh
      // attemptSalt). Best-effort — never turns the spec's own outcome.
      const cleanup = async () => {
        if (!exampleCase.cleanup) return;
        try {
          using admin = await connectAdminItx(baseURL!);
          using project = admin.projects.get(fixture.project.id);
          await exampleCase.cleanup(project, ctx);
        } catch (error) {
          console.warn(`example "${example.id}" cleanup failed (ignored):`, error);
        }
      };

      try {
        await test.step("run catalogue example", async () => {
          let code = example.code;
          if (exampleCase.vars) {
            const json = JSON5.stringify(exampleCase.vars(ctx), null, 2);
            code = `const vars = ${json};\n\n${example.code}`;
          }

          const editor = page.getByTestId("itx-repl-editor").locator(".cm-content");
          await editor.fill(code);

          await page.getByRole("button", { name: "Run", exact: true }).click();

          const entry = page.locator(`[data-entry-index="${entryIndex}"][data-status="success"]`);
          // An errored entry must fail NOW with the real error text — waiting the
          // full success budget over a visible error burned 2×150s per attempt on
          // a transient sandbox-runtime error (marathon zqqp1b9qd5 run 4) and let
          // the retry start that much later.
          const errorEntry = page.locator(
            `[data-entry-index="${entryIndex}"][data-status="error"]`,
          );
          const failFastOnError = async (budgetMs: number) => {
            // Both branches swallow their own rejection (the loser's timeout must
            // not surface as an unhandled rejection after the winner settles).
            const outcome = await Promise.race([
              // timeout: the step's success budget rides both race branches — past any spinner-waiter ceiling
              entry.waitFor({ timeout: budgetMs }).then(
                () => "success" as const,
                () => "timeout" as const,
              ),
              // timeout: same shared race budget as the success branch — past any spinner-waiter ceiling
              errorEntry.waitFor({ timeout: budgetMs }).then(
                () => "error" as const,
                () => "timeout" as const,
              ),
            ]);
            if (outcome === "error") {
              const message = await errorEntry.getByTestId("itx-repl-error").textContent();
              throw new Error(`REPL entry errored: ${message?.slice(0, 500)}`);
            }
            if (outcome === "timeout") {
              throw new Error(
                `REPL entry neither succeeded nor errored within ${budgetMs}ms (still running)`,
              );
            }
          };
          if (exampleCase.completionTimeoutMs) {
            // spinner-waiter caps "spinner still visible" waits at 30s, which is
            // exactly the state a long-running example is in — bypass it and wait
            // for the entry directly with the example's own budget.
            await spinnerWaiter.settings.run({ disabled: true }, () =>
              failFastOnError(exampleCase.completionTimeoutMs!),
            );
          } else {
            // A REPL Run is a real scope script now: first runs in a fresh
            // project pay scope birth + the typecheck gate + dynamic-worker
            // spin-up on top of the script itself — the run-script matrix
            // lane budgets 90s for the same path. The pending row shows a
            // spinner the whole time, so bypass spinner-waiter's 30s cap here
            // too.
            await spinnerWaiter.settings.run({ disabled: true }, () => failFastOnError(90_000));
          }

          const resultJson = await entry.getByTestId("itx-repl-result-json").textContent();
          const result = JSON.parse(resultJson!);

          exampleCase.assert(result, ctx, expect as never);
          const visibleResult = entry.getByTestId("itx-repl-visible-result");
          await visibleResult.locator(".cm-SerializedObjectCodeBlock .cm-content").waitFor();
        });
      } finally {
        await test.step("clean up catalogue example", cleanup);
      }
    });
  }
});
