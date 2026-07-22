import type { TestInfo } from "@playwright/test";
import { createForgedBrowserFixture } from "./forged-session.ts";
import { ReplProjectPool, type ReplProjectLease } from "./repl-project-pool.ts";
import { test as base } from "./test.ts";

type ReplFixture = Awaited<ReturnType<typeof createForgedBrowserFixture>> & {
  retire(): void;
};

export const test = base.extend<{ replFixture: ReplFixture }, { replProjectPool: ReplProjectPool }>(
  {
    replProjectPool: [
      async ({ browserName: _browserName }, use, workerInfo) => {
        await use(new ReplProjectPool(`repl-pool-w${workerInfo.workerIndex + 1}`));
      },
      { scope: "worker" },
    ],
    replFixture: async ({ adminItx, baseURL, page, replProjectPool }, use, testInfo: TestInfo) => {
      if (!baseURL) throw new Error("Playwright baseURL fixture is required.");
      const lease = await base.step("fixture: acquire REPL project", () =>
        replProjectPool.acquire(adminItx, (name, body) => base.step(name, body)),
      );
      try {
        const browserFixture = await createForgedBrowserFixture(
          "repl-pool-session",
          {
            baseURL,
            page,
            step: (name, body) => base.step(name, body),
          },
          [lease.project],
        );
        const fixture: ReplFixture = Object.assign(browserFixture, {
          retire: () => lease.retire(),
        });
        await attachProjectCorrelation(testInfo, lease);
        await use(fixture);
        if (
          testInfo.status === "failed" ||
          testInfo.status === "timedOut" ||
          testInfo.status === "interrupted"
        ) {
          lease.retire();
        }
        try {
          await browserFixture[Symbol.asyncDispose]();
        } catch (error) {
          lease.retire();
          throw error;
        }
      } catch (error) {
        lease.retire();
        throw error;
      } finally {
        lease[Symbol.dispose]();
      }
    },
  },
);

async function attachProjectCorrelation(testInfo: TestInfo, lease: ReplProjectLease) {
  const correlation = {
    pool: "repl-examples",
    projectIds: [lease.project.id],
    projectSlugs: [lease.project.slug],
  };
  testInfo.annotations.push({
    type: "fixture-projects",
    description: JSON.stringify(correlation),
  });
  await testInfo.attach("fixture-projects", {
    body: JSON.stringify(correlation, null, 2),
    contentType: "application/json",
  });
}
