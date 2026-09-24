import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import {
  analyzeTestTelemetryCompleteness,
  unitTestWorkspaces,
} from "./test-telemetry-completeness.ts";
import { writeFlakeSuiteSummaries } from "./flake-suite-summary.ts";

const DEFAULT_ARTIFACT_ROOT = "test-results/ci-telemetry";

async function loadTestTelemetryArtifacts(rawDirectory: string) {
  const files = (await filesBelow(rawDirectory)).filter((file) => file.endsWith(".json"));
  const artifacts = await Promise.all(
    files.map(async (file) => ({
      file,
      artifact: TestTelemetryArtifact.parse(JSON.parse(await readFile(file, "utf8"))),
    })),
  );
  const duplicateIds = duplicateValues(artifacts.map(({ artifact }) => artifact.artifactId));
  if (duplicateIds.length > 0) {
    throw new Error(`Duplicate test telemetry artifact IDs: ${duplicateIds.join(", ")}`);
  }
  return artifacts;
}

/**
 * The CI job's telemetry finalizer (`--flake-suites unit|preview`, an `if: always()` step after the
 * test runners). It checks that every expected runner left a complete artifact
 * (test-telemetry-completeness.ts), writes `manifest.json` beside the raw artifacts, and writes each
 * suite's `suite-summary.json` for the flake dashboard. It fails the job on missing, incomplete or
 * foreign evidence, after writing both, so the upload step that follows keeps what there is.
 */
export async function finalizeTestTelemetry(options: {
  artifactRoot: string;
  cancelled?: boolean;
  expectedWorkspaces?: readonly string[];
  flakeSuites?: "unit" | "preview";
  headSha?: string;
}) {
  const artifactRoot = resolve(options.artifactRoot);
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
    await writeFlakeSuiteSummaries({
      directory: resolve(artifactRoot, "../flake-records"),
      group: options.flakeSuites,
      artifacts: loaded.map(({ artifact }) => artifact),
      expectedWorkspaces: [...expectedWorkspaces],
      cancelled: options.cancelled || false,
      headSha,
    });
  }
  console.log(`[test-telemetry] checked ${loaded.length} artifact(s)`);
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

async function filesBelow(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? filesBelow(path) : Promise.resolve([path]);
      }),
    )
  ).flat();
}

function duplicateValues(values: readonly string[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

if (isMainModule(import.meta.url)) {
  const flakeSuitesIndex = process.argv.indexOf("--flake-suites");
  let flakeSuites: "unit" | "preview" | undefined;
  if (flakeSuitesIndex !== -1) {
    const group = process.argv[flakeSuitesIndex + 1];
    if (group !== "unit" && group !== "preview")
      throw new Error("--flake-suites requires unit or preview");
    flakeSuites = group;
  }
  const rootFlagIndex = process.argv.indexOf("--artifact-root");
  const artifactRoot =
    rootFlagIndex === -1 ? DEFAULT_ARTIFACT_ROOT : process.argv[rootFlagIndex + 1];
  if (!artifactRoot || artifactRoot.startsWith("--")) {
    throw new Error("--artifact-root requires a path");
  }
  // `--expect-unit-workspaces`: the checked-out tree's test workspaces (the Test workflow);
  // otherwise the list the workflow names (the preview lanes' `iterate-root,os`).
  const expectedWorkspaces = process.argv.includes("--expect-unit-workspaces")
    ? unitTestWorkspaces(process.cwd())
    : (process.env.TEST_TELEMETRY_EXPECTED_WORKSPACES || "")
        .split(",")
        .map((workspace) => workspace.trim())
        .filter(Boolean);
  await finalizeTestTelemetry({
    artifactRoot,
    cancelled: process.argv.includes("--cancelled"),
    expectedWorkspaces,
    flakeSuites,
    headSha: process.env.TEST_TELEMETRY_HEAD_SHA,
  });
}
