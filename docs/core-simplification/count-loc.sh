#!/usr/bin/env bash
# Physical lines in tracked TypeScript/TSX files. Pass a revision for a pinned count.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

node - "${1:-}" <<'NODE'
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const revision = process.argv[2];
const commit = execFileSync("git", ["rev-parse", revision || "HEAD"], { encoding: "utf8" }).trim();
const files = execFileSync("git", revision ? ["ls-tree", "-r", "--name-only", commit] : ["ls-files"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter((file) => file && (revision || fs.existsSync(file)));
const physicalLines = (file) => {
  const contents = revision
    ? execFileSync("git", ["show", `${commit}:${file}`], { encoding: "utf8" })
    : fs.readFileSync(file, "utf8");
  return contents.split("\n").length - 1;
};
console.log(`revision\t${commit}${revision ? "" : " (tracked working files)"}`);
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
    // The private subscriptions facet is core delivery code. Keep it in the
    // selector so moving logic from the context DO cannot look like a deletion.
    "subscription-delivery-durable-object",
  ].map((name) => `apps/os/src/${name}.ts`),
);

const isKernelRuntime = (file) =>
  (file.startsWith("apps/os/src/context/") && isRuntime(file)) ||
  (file.startsWith("apps/os/src/stream/") && isRuntime(file)) ||
  coreEntrypoints.has(file);

const groups = {
  "narrow core runtime": (file) => isKernelRuntime(file),
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
