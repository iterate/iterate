import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { createCli } from "trpc-cli";
import type { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import {
  UNIT_ROW_WARN_EXEMPTIONS,
  UNIT_ROW_WARN_MS,
} from "@iterate-com/shared/test-support/e2e-policy";
import {
  analyzeTestTelemetryCompleteness,
  loadTestTelemetryArtifacts,
} from "./test-telemetry-completeness.ts";
import { writeFlakeSuiteSummary, type FlakeSuite } from "./flake-suite-summary.ts";

/**
 * THE CI JOB'S TELEMETRY FINALIZER, which scripts/ci/test-evidence.ts `finalize` runs after the
 * test runners (`if: always()`), and this file's one command, to check a job's downloaded telemetry
 * again (docs/ci-test-telemetry.md). It checks that every expected runner left a complete artifact
 * (test-telemetry-completeness.ts), writes `manifest.json` beside the raw artifacts, and writes the
 * job's suite's `suite-summary.json` for the flake dashboard. It fails on missing, incomplete or
 * foreign evidence, after writing both, so the upload step that follows keeps what there is.
 */
export default async function finalizeTestTelemetry(
  options: {
    /** Where the raw telemetry artifacts are (default test-results/ci-telemetry). */
    artifactRoot?: string;
    /** The job was cancelled (the workflow's `cancelled()`). */
    cancelled?: boolean;
    /** The workspaces whose runners must each have left an artifact. */
    expectedWorkspaces?: string[];
    /** The flake suite this job ran, for its suite-summary.json. */
    flakeSuites?: FlakeSuite;
    /** The tested commit the suite summary names (TEST_TELEMETRY_HEAD_SHA in CI). */
    headSha?: string;
  } = {},
) {
  const artifactRoot = resolve(options.artifactRoot || "test-results/ci-telemetry");
  const rawDirectory = join(artifactRoot, "raw");
  const loaded = await loadTestTelemetryArtifacts(rawDirectory);
  if (loaded.length === 0 && !options.cancelled) {
    throw new Error(`No test telemetry artifacts found below ${rawDirectory}`);
  }
  const expectedWorkspaces = options.expectedWorkspaces || [];
  const completeness = analyzeTestTelemetryCompleteness(
    loaded.map(({ artifact }) => artifact),
    expectedWorkspaces,
  );
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(
    join(artifactRoot, "manifest.json"),
    `${JSON.stringify(
      {
        artifactCount: loaded.length,
        cancelled: options.cancelled ?? false,
        expectedWorkspaces,
        ...completeness,
        artifacts: loaded.map(({ artifact, file }) => ({
          artifactId: artifact.artifactId,
          producer: artifact.producer,
          file: relative(artifactRoot, file),
          testCount: artifact.tests.length,
        })),
      },
      null,
      2,
    )}\n`,
  );
  // Cancellation before any reporter starts has no source identity for a summary.
  // Keep the cancelled manifest; absence of a summary cannot clear the dashboard.
  if (options.flakeSuites && loaded.length > 0) {
    const { headSha } = options;
    if (!headSha)
      throw new Error("TEST_TELEMETRY_HEAD_SHA is required for full flake suite summaries");
    await writeFlakeSuiteSummary({
      directory: resolve(artifactRoot, "../flake-records"),
      suite: options.flakeSuites,
      artifacts: loaded.map(({ artifact }) => artifact),
      expectedWorkspaces: [...expectedWorkspaces],
      cancelled: options.cancelled || false,
      headSha,
    });
  }
  console.log(`[test-telemetry] checked ${loaded.length} artifact(s)`);
  if (options.flakeSuites === "unit" && !options.cancelled)
    for (const line of unitRowBudget(loaded.map(({ artifact }) => artifact))) console.log(line);
  if (!options.cancelled) {
    const { foreignArtifactIds, incompleteArtifactIds, missingWorkspaces } = completeness;
    const failures = [
      ...(missingWorkspaces.length > 0
        ? [`Missing expected test telemetry workspaces: ${missingWorkspaces.join(", ")}`]
        : []),
      ...(incompleteArtifactIds.length > 0
        ? [`Incomplete test telemetry artifacts: ${incompleteArtifactIds.join(", ")}`]
        : []),
      ...(foreignArtifactIds.length > 0
        ? [`Foreign test telemetry artifacts: ${foreignArtifactIds.join(", ")}`]
        : []),
    ];
    if (failures.length > 0) throw new Error(failures.join("; "));
  }
  return loaded.map(({ artifact }) => artifact);
}

/**
 * The Test job's row budget, a warning only: every unit or Workers row over `UNIT_ROW_WARN_MS`
 * that `UNIT_ROW_WARN_EXEMPTIONS` does not list, and each listed title that no longer names a row
 * over it (docs/testing.md#the-row-budget).
 */
export function unitRowBudget(artifacts: TestTelemetryArtifact[]) {
  const rows = artifacts
    .filter((artifact) => artifact.context.testKind === "unit")
    .flatMap((artifact) =>
      artifact.tests.map((test) => ({
        name: test.leafName || test.fullName,
        file: basename(test.moduleId),
        durationMs: test.durationMs,
      })),
    );
  const over = rows
    .filter((row) => row.durationMs > UNIT_ROW_WARN_MS && !UNIT_ROW_WARN_EXEMPTIONS[row.name])
    .toSorted((a, b) => b.durationMs - a.durationMs);
  const stale = Object.keys(UNIT_ROW_WARN_EXEMPTIONS).filter(
    (name) => !rows.some((row) => row.name === name && row.durationMs > UNIT_ROW_WARN_MS),
  );
  return [
    ...(over.length === 0
      ? []
      : [
          `[row-budget] ${over.length} unit or Workers row(s) ran longer than ${UNIT_ROW_WARN_MS / 1000} s. Make each faster, or list it with its reason in UNIT_ROW_WARN_EXEMPTIONS (packages/shared/src/test-support/e2e-policy/budgets.ts):`,
          ...over.map(
            (row) =>
              `[row-budget] ${(row.durationMs / 1000).toFixed(1)} s ${row.file}: ${row.name}`,
          ),
        ]),
    ...stale.map(
      (name) =>
        `[row-budget] UNIT_ROW_WARN_EXEMPTIONS lists a row that did not run longer than ${UNIT_ROW_WARN_MS / 1000} s; drop the entry: ${name}`,
    ),
  ];
}

if (isMainModule(import.meta.url))
  void createCli({ ...import.meta, name: "test-telemetry-finalizer" }).run();
