import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TEST_TELEMETRY_INCOMPLETE_ERROR_NAME,
  TestTelemetryArtifact,
} from "@iterate-com/shared/test-support/ci-telemetry";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * The workspaces `pnpm test` runs in the tree at `root`: every package in pnpm-workspace.yaml whose
 * package.json has a `test` script, by package name. The Test workflow's finalizer expects exactly
 * these (`--expect-unit-workspaces`), read from the checked-out tree and not listed in test.yml:
 * Depot runs a pull request's workflow file from its merge ref, and a list there that names a
 * workspace the job's checkout lacks, or misses one it has, fails the Test check with every test
 * green.
 */
export function unitTestWorkspaces(root: string): string[] {
  const { packages } = z
    .object({ packages: z.array(z.string()) })
    .parse(parseYaml(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")));
  return packages.flatMap((directory) => {
    const { name, scripts } = z
      .object({ name: z.string(), scripts: z.record(z.string(), z.string()).optional() })
      .parse(JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8")));
    return scripts?.test ? [name] : [];
  });
}

/**
 * What a CI job's telemetry artifacts fail to prove. A runner that never started leaves no
 * artifact, so the job names the workspaces it runs (`unitTestWorkspaces`, or
 * `TEST_TELEMETRY_EXPECTED_WORKSPACES`) and
 * each missing one is reported. A runner killed after it started leaves its pessimistic sentinel,
 * reported as incomplete. An artifact from another CI run, attempt or job is foreign: the newest
 * artifact's run is this job's.
 */
export function analyzeTestTelemetryCompleteness(
  artifacts: readonly TestTelemetryArtifact[],
  expectedWorkspaces: readonly string[],
) {
  const newest = artifacts.reduce<TestTelemetryArtifact | undefined>(
    (current, candidate) =>
      !current || candidate.run.finishedAt > current.run.finishedAt ? candidate : current,
    undefined,
  );
  const currentArtifacts = newest
    ? artifacts.filter((artifact) => ciScopeKey(artifact) === ciScopeKey(newest))
    : artifacts;
  const observedWorkspaces = [
    ...new Set(
      currentArtifacts.flatMap((artifact) =>
        artifact.context.workspace ? [artifact.context.workspace] : [],
      ),
    ),
  ];
  return {
    foreignArtifactIds: artifacts
      .filter((artifact) => !currentArtifacts.includes(artifact))
      .map(({ artifactId }) => artifactId),
    incompleteArtifactIds: artifacts
      .filter((artifact) => artifact.run.error?.name === TEST_TELEMETRY_INCOMPLETE_ERROR_NAME)
      .map(({ artifactId }) => artifactId),
    missingWorkspaces: expectedWorkspaces.filter(
      (workspace) => !observedWorkspaces.includes(workspace),
    ),
    observedWorkspaces,
  };
}

/** Whether a test failed: Playwright's unexpected outcome when it has one, otherwise vitest's final
 *  failed or timed-out state. */
export function testTelemetryFailed(
  test: Pick<TestTelemetryArtifact["tests"][number], "outcome" | "state">,
) {
  if (test.outcome) return test.outcome === "unexpected";
  return ["failed", "timedout"].includes(test.state.toLowerCase());
}

function ciScopeKey({ ci }: TestTelemetryArtifact) {
  return [ci.repository, ci.workflowRunId, ci.workflowRunAttempt, ci.jobName || ""].join("\0");
}

/** Every raw telemetry artifact below `rawDirectory`, each schema-checked, with its file. Two with
 *  one id (a runner's artifact counted twice) fail. */
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
