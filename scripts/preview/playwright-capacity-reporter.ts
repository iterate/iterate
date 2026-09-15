import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FullConfig, Reporter, Suite } from "@playwright/test/reporter";

// Fixed counts for the retained sharded experiment. The active preview
// workflow is unsharded; its worker count is varied explicitly between runs.
export const previewPlaywrightShards = [1, 2, 3, 4, 5, 6];
export const previewPlaywrightWorkers = 64;

export function assertPlaywrightCapacity(input: {
  tests: number;
  workers: number;
  shard: FullConfig["shard"];
}) {
  if (input.shard && input.shard.total !== previewPlaywrightShards.length) {
    throw new Error("Preview Playwright requires six shards; update the fixed capacity together.");
  }
  const capacity = input.workers * (input.shard ? 1 : previewPlaywrightShards.length);
  if (input.tests > capacity) {
    throw new Error(
      `Preview Playwright has ${input.tests} tests but only ${capacity} slots. Increase the fixed shards/workers so every test can start without waiting for another test.`,
    );
  }
}

/** Also used with --list before any deployment, so catalogue growth fails cheaply. */
export default class PlaywrightCapacityReporter implements Reporter {
  private failed = false;

  onBegin(config: FullConfig, suite: Suite) {
    try {
      if (!config.fullyParallel) {
        throw new Error("Preview Playwright projects must enable fullyParallel.");
      }
      assertPlaywrightCapacity({
        tests: suite.allTests().length,
        workers: config.workers,
        shard: config.shard,
      });
      if (process.env.PLAYWRIGHT_CAPACITY_FILE) {
        mkdirSync(dirname(process.env.PLAYWRIGHT_CAPACITY_FILE), { recursive: true });
        writeFileSync(
          process.env.PLAYWRIGHT_CAPACITY_FILE,
          JSON.stringify({ testCount: suite.allTests().length }),
        );
      }
      console.log(
        `[preview:capacity] ${suite.allTests().length} tests; ${config.workers} workers; shard ${config.shard ? `${config.shard.current}/${config.shard.total}` : "all"}`,
      );
    } catch (error) {
      this.failed = true;
      console.error(String(error));
    }
  }

  async onEnd() {
    // Playwright catches reporter exceptions; explicitly override the result.
    if (this.failed) return { status: "failed" as const };
  }
}
