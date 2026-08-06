import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import { sendPostHogEvents } from "./posthog-events.ts";
import {
  analyzeTestTelemetryCompleteness,
  testTelemetryArtifactSourceLabel,
  type MissingArtifactSource,
  type TestTelemetryCompleteness,
} from "./test-telemetry-completeness.ts";
import { testTelemetryEvents, testTelemetryFinalizerEvent } from "./test-telemetry-events.ts";

const DEFAULT_ARTIFACT_ROOT = "test-results/ci-telemetry";

export { testTelemetryEvents } from "./test-telemetry-events.ts";

export async function loadTestTelemetryArtifacts(rawDirectory: string) {
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

export async function finalizeTestTelemetry(options: {
  artifactRoot: string;
  cancelled?: boolean;
  dryRun?: boolean;
  expectedWorkspaces?: readonly string[];
}) {
  const artifactRoot = resolve(options.artifactRoot);
  const rawDirectory = join(artifactRoot, "raw");
  const loaded = await loadTestTelemetryArtifacts(rawDirectory);
  if (loaded.length === 0 && !options.cancelled) {
    throw new Error(`No test telemetry artifacts found below ${rawDirectory}`);
  }
  const telemetryEvents = loaded.flatMap(({ artifact }) => testTelemetryEvents(artifact));
  const runnerEventCount = telemetryEvents.filter(({ event }) =>
    event.startsWith("ci test "),
  ).length;
  const completeness = analyzeTestTelemetryCompleteness(
    loaded.map(({ artifact }) => artifact),
    options.expectedWorkspaces ?? [],
  );
  const {
    expectedArtifactSources,
    foreignArtifactIds,
    incompleteArtifactIds,
    missingArtifactSources,
    missingWorkspaces,
    observedArtifactSources,
    observedWorkspaces,
    primaryArtifact,
  } = completeness;
  const events = [
    ...telemetryEvents,
    ...(primaryArtifact
      ? [
          testTelemetryFinalizerEvent({
            artifactCount: loaded.length,
            cancelled: options.cancelled ?? false,
            expectedArtifactSources,
            expectedWorkspaces: options.expectedWorkspaces ?? [],
            foreignArtifactIds,
            incompleteArtifactIds,
            missingArtifactSources,
            missingWorkspaces,
            observedArtifactSourceCount: observedArtifactSources.length,
            observedWorkspaceCount: observedWorkspaces.length,
            primaryArtifact,
            runnerEventCount,
          }),
        ]
      : []),
  ];
  const normalizedDirectory = join(artifactRoot, "normalized");
  await mkdir(normalizedDirectory, { recursive: true });
  await writeNormalizedOutput({
    artifactRoot,
    cancelled: options.cancelled ?? false,
    events,
    expectedArtifactSources,
    expectedWorkspaces: options.expectedWorkspaces ?? [],
    foreignArtifactIds,
    incompleteArtifactIds,
    loaded,
    missingArtifactSources,
    missingWorkspaces,
    normalizedDirectory,
    observedArtifactSources,
    observedWorkspaces,
  });
  console.log(
    `[test-telemetry] normalized ${loaded.length} artifact(s) into ${events.length} event(s)`,
  );
  // PostHog upload paused (billing). Artifacts still normalized/retained.
  // Re-enable: CI_TELEMETRY_POSTHOG_ENABLED=1
  if (
    !options.dryRun &&
    !options.cancelled &&
    events.length > 0 &&
    process.env.CI_TELEMETRY_POSTHOG_ENABLED === "1"
  ) {
    await sendPostHogEvents(events);
  }
  if (!options.cancelled) {
    const failures = [
      ...(missingWorkspaces.length > 0
        ? [`Missing expected test telemetry workspaces: ${missingWorkspaces.join(", ")}`]
        : []),
      ...(missingArtifactSources.length > 0
        ? [
            `Missing expected test telemetry artifact sources: ${missingArtifactSources
              .map(
                ({ source, expectedCount, observedCount }) =>
                  `${testTelemetryArtifactSourceLabel(source)} (expected ${expectedCount}, observed ${observedCount})`,
              )
              .join(", ")}`,
          ]
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
  return { artifacts: loaded.map(({ artifact }) => artifact), events };
}

async function writeNormalizedOutput(input: {
  artifactRoot: string;
  cancelled: boolean;
  events: ReturnType<typeof testTelemetryEvents>;
  expectedArtifactSources: TestTelemetryCompleteness["expectedArtifactSources"];
  expectedWorkspaces: readonly string[];
  foreignArtifactIds: readonly string[];
  incompleteArtifactIds: readonly string[];
  loaded: Array<{ artifact: TestTelemetryArtifact; file: string }>;
  missingArtifactSources: readonly MissingArtifactSource[];
  missingWorkspaces: readonly string[];
  normalizedDirectory: string;
  observedArtifactSources: TestTelemetryCompleteness["observedArtifactSources"];
  observedWorkspaces: readonly string[];
}) {
  await writeFile(
    join(input.normalizedDirectory, "posthog-events.json"),
    `${JSON.stringify({ schemaVersion: 2, events: input.events }, null, 2)}\n`,
  );
  await writeFile(
    join(input.normalizedDirectory, "manifest.json"),
    `${JSON.stringify(
      {
        artifactCount: input.loaded.length,
        cancelled: input.cancelled,
        eventCount: input.events.length,
        expectedArtifactSources: input.expectedArtifactSources,
        expectedWorkspaces: input.expectedWorkspaces,
        foreignArtifactIds: input.foreignArtifactIds,
        incompleteArtifactIds: input.incompleteArtifactIds,
        missingArtifactSources: input.missingArtifactSources,
        missingWorkspaces: input.missingWorkspaces,
        observedArtifactSources: input.observedArtifactSources,
        observedWorkspaces: input.observedWorkspaces,
        artifacts: input.loaded.map(({ artifact, file }) => ({
          artifactId: artifact.artifactId,
          producer: artifact.producer,
          file: relative(input.artifactRoot, file),
          testCount: artifact.tests.length,
        })),
      },
      null,
      2,
    )}\n`,
  );
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
  const rootFlagIndex = process.argv.indexOf("--artifact-root");
  const artifactRoot =
    rootFlagIndex === -1
      ? (process.env.TEST_TELEMETRY_ARTIFACT_ROOT ?? DEFAULT_ARTIFACT_ROOT)
      : process.argv[rootFlagIndex + 1];
  if (!artifactRoot || artifactRoot.startsWith("--")) {
    throw new Error("--artifact-root requires a path");
  }
  const expectedWorkspaces = (process.env.TEST_TELEMETRY_EXPECTED_WORKSPACES ?? "")
    .split(",")
    .map((workspace) => workspace.trim())
    .filter(Boolean);
  const cancelled = process.argv.includes("--cancelled");
  await finalizeTestTelemetry({
    artifactRoot,
    cancelled,
    dryRun: cancelled || process.argv.includes("--dry-run"),
    expectedWorkspaces,
  });
}
