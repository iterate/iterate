import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import { sendPostHogEvents } from "./posthog-events.ts";
import { testTelemetryArtifactIncomplete, testTelemetryEvents } from "./test-telemetry-events.ts";

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
  const events = loaded.flatMap(({ artifact }) => testTelemetryEvents(artifact));
  const incompleteArtifactIds = loaded
    .filter(({ artifact }) => testTelemetryArtifactIncomplete(artifact))
    .map(({ artifact }) => artifact.artifactId);
  const observedWorkspaces = new Set(
    loaded.flatMap(({ artifact }) =>
      artifact.context.workspace === undefined ? [] : [artifact.context.workspace],
    ),
  );
  const missingWorkspaces = (options.expectedWorkspaces ?? []).filter(
    (workspace) => !observedWorkspaces.has(workspace),
  );
  const normalizedDirectory = join(artifactRoot, "normalized");
  await mkdir(normalizedDirectory, { recursive: true });
  await writeNormalizedOutput({
    artifactRoot,
    cancelled: options.cancelled ?? false,
    events,
    expectedWorkspaces: options.expectedWorkspaces ?? [],
    incompleteArtifactIds,
    loaded,
    missingWorkspaces,
    normalizedDirectory,
  });
  console.log(
    `[test-telemetry] normalized ${loaded.length} artifact(s) into ${events.length} event(s)`,
  );
  if (!options.dryRun && !options.cancelled && events.length > 0) await sendPostHogEvents(events);
  if (!options.cancelled) {
    const failures = [
      ...(missingWorkspaces.length > 0
        ? [`Missing expected test telemetry workspaces: ${missingWorkspaces.join(", ")}`]
        : []),
      ...(incompleteArtifactIds.length > 0
        ? [`Incomplete test telemetry artifacts: ${incompleteArtifactIds.join(", ")}`]
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
  expectedWorkspaces: readonly string[];
  incompleteArtifactIds: readonly string[];
  loaded: Array<{ artifact: TestTelemetryArtifact; file: string }>;
  missingWorkspaces: readonly string[];
  normalizedDirectory: string;
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
        expectedWorkspaces: input.expectedWorkspaces,
        incompleteArtifactIds: input.incompleteArtifactIds,
        missingWorkspaces: input.missingWorkspaces,
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
