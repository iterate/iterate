/// <reference types="node" />
// expression-memory.test.ts — a facet-hosting expression with a legal 4.5 MiB JSON5 source must
// parse within a Durable Object's heap budget. This is a child because V8 heap death is process-wide.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const SCENARIO = fileURLToPath(new URL("./expression-memory-scenario.ts", import.meta.url).href);
const ISOLATE_BUDGET_MB = 128;

test(
  "a 4.5 MiB hosted-facet JSON5 source parses within the isolate heap budget",
  { timeout: 60_000 },
  () => {
    const child = spawnSync(
      process.execPath,
      [`--max-old-space-size=${ISOLATE_BUDGET_MB}`, "--import", "tsx", SCENARIO],
      { encoding: "utf8", timeout: 55_000 },
    );
    expect(`${child.stdout}\n${child.stderr}`).toContain('"sourceChars":4718592');
    expect(child.status).toBe(0);
  },
);
