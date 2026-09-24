import {
  TEST_TELEMETRY_INCOMPLETE_ERROR_NAME,
  type TestTelemetryArtifact,
} from "@iterate-com/shared/test-support/ci-telemetry";

/**
 * What a CI job's telemetry artifacts fail to prove. A runner that never started leaves no
 * artifact, so the workflow names the workspaces it runs (`TEST_TELEMETRY_EXPECTED_WORKSPACES`) and
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
        artifact.context.workspace === undefined ? [] : [artifact.context.workspace],
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
export function testTelemetryFailed(test: TestTelemetryArtifact["tests"][number]): boolean {
  if (test.outcome) return test.outcome === "unexpected";
  return ["failed", "timedout"].includes(test.state.toLowerCase());
}

function ciScopeKey({ ci }: TestTelemetryArtifact) {
  return [ci.repository, ci.workflowRunId, ci.workflowRunAttempt, ci.jobName || ""].join("\0");
}
