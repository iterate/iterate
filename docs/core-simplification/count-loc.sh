#!/usr/bin/env bash
# Physical lines in tracked TypeScript/TSX files. Run from any directory in this checkout.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

node <<'NODE'
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);
const physicalLines = (file) => fs.readFileSync(file, "utf8").split("\n").length - 1;
const isTs = (file) => /\.(?:ts|tsx)$/.test(file);
const isUnitTest = (file) => /\.test\.(?:ts|tsx)$/.test(file);
const isTestSupport = (file) => /(?:^|\/)[^/]*test-(?:support|internal)[^/]*\.(?:ts|tsx)$/.test(file);
const isRuntime = (file) => isTs(file) && !isUnitTest(file) && !isTestSupport(file);
const coreEntrypoints = new Set(
  [
    "alarm-coordinator",
    "caller",
    "cause",
    "context-stub",
    "fetch-routes",
    "first-party-facets",
    "iterate-context",
    "iterate-context-durable-object",
    "kept",
    "unavailable",
    "worker",
  ].map((name) => `apps/os/src/${name}.ts`),
);

const groups = {
  "context engine runtime": (file) => file.startsWith("apps/os/src/context/") && isRuntime(file),
  "stream engine runtime": (file) => file.startsWith("apps/os/src/stream/") && isRuntime(file),
  "context shell runtime": (file) => coreEntrypoints.has(file),
  "SDK runtime": (file) => file.startsWith("packages/iterate/src/") && isRuntime(file),
  "context engine unit tests": (file) => file.startsWith("apps/os/src/context/") && isUnitTest(file),
  "stream engine unit tests": (file) => file.startsWith("apps/os/src/stream/") && isUnitTest(file),
  "SDK unit tests": (file) => file.startsWith("packages/iterate/src/") && isUnitTest(file),
  "Workers runtime tests": (file) => file.startsWith("apps/os/__workers-tests__/") && isUnitTest(file),
  "OS protocol e2e tests": (file) => file.startsWith("apps/os/e2e/") && /\.e2e\.test\.ts$/.test(file),
  "OS performance tests": (file) => file.startsWith("apps/os/perf/") && /\.perf\.test\.ts$/.test(file),
  "OS generated declarations": (file) => file.startsWith("apps/os/src/generated/") && isTs(file),
  "all OS runtime, excluding generated": (file) =>
    file.startsWith("apps/os/src/") && isTs(file) && !isUnitTest(file) && !file.startsWith("apps/os/src/generated/"),
  "all OS colocated unit tests": (file) => file.startsWith("apps/os/src/") && isUnitTest(file),
};

for (const [name, includes] of Object.entries(groups)) {
  const selected = files.filter(includes);
  const lines = selected.reduce((total, file) => total + physicalLines(file), 0);
  console.log(`${name}\t${selected.length}\t${lines}`);
}
NODE
