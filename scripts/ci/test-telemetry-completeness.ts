import {
  TEST_TELEMETRY_INCOMPLETE_ERROR_NAME,
  type TestTelemetryArtifact,
  type TestTelemetryArtifactSource,
} from "@iterate-com/shared/test-support/ci-telemetry";

type ArtifactCiScope = {
  repository: string;
  workflowRunId: string;
  workflowRunAttempt: string;
  jobName?: string;
};

type ScopedArtifactSource = {
  source: TestTelemetryArtifactSource;
  ciScope: ArtifactCiScope;
};

export type MissingArtifactSource = ScopedArtifactSource & {
  expectedCount: number;
  observedCount: number;
  missingCount: number;
};

export type TestTelemetryCompleteness = {
  expectedArtifactSources: TestTelemetryArtifactSource[];
  foreignArtifactIds: string[];
  incompleteArtifactIds: string[];
  missingArtifactSources: MissingArtifactSource[];
  missingWorkspaces: string[];
  observedArtifactSources: TestTelemetryArtifactSource[];
  observedWorkspaces: string[];
  primaryArtifact: TestTelemetryArtifact | undefined;
};

export function analyzeTestTelemetryCompleteness(
  artifacts: readonly TestTelemetryArtifact[],
  expectedWorkspaces: readonly string[],
): TestTelemetryCompleteness {
  const primaryArtifact = selectPrimaryArtifact(artifacts);
  const currentArtifacts = !primaryArtifact
    ? artifacts
    : artifacts.filter(
        (artifact) =>
          ciScopeKey(artifactCiScope(artifact)) === ciScopeKey(artifactCiScope(primaryArtifact)),
      );
  const foreignArtifactIds = artifacts
    .filter((artifact) => !currentArtifacts.includes(artifact))
    .map(({ artifactId }) => artifactId);
  const incompleteArtifactIds = artifacts
    .filter(testTelemetryArtifactIncomplete)
    .map(({ artifactId }) => artifactId);
  const observedWorkspaces = [
    ...new Set(
      currentArtifacts.flatMap((artifact) =>
        !artifact.context.workspace ? [] : [artifact.context.workspace],
      ),
    ),
  ];
  const expectedScopedArtifactSources = currentArtifacts.flatMap((artifact) =>
    (artifact.expectedArtifactSources ?? []).map((source) =>
      scopedArtifactSource(artifact, source),
    ),
  );
  const observedScopedArtifactSources = currentArtifacts.flatMap((artifact) => {
    const source = testTelemetryArtifactSource(artifact);
    return !source ? [] : [scopedArtifactSource(artifact, source)];
  });

  return {
    expectedArtifactSources: expectedScopedArtifactSources.map(({ source }) => source),
    foreignArtifactIds,
    incompleteArtifactIds,
    missingArtifactSources: findMissingArtifactSources(
      expectedScopedArtifactSources,
      observedScopedArtifactSources,
    ),
    missingWorkspaces: expectedWorkspaces.filter(
      (workspace) => !observedWorkspaces.includes(workspace),
    ),
    observedArtifactSources: observedScopedArtifactSources.map(({ source }) => source),
    observedWorkspaces,
    primaryArtifact,
  };
}

export function testTelemetryArtifactIncomplete(artifact: TestTelemetryArtifact) {
  return artifact.run.error?.name === TEST_TELEMETRY_INCOMPLETE_ERROR_NAME;
}

export function testTelemetryArtifactSource(
  artifact: TestTelemetryArtifact,
): TestTelemetryArtifactSource | null {
  const { workspace } = artifact.context;
  if (!workspace) return null;
  return {
    producer: artifact.producer,
    framework: artifact.context.framework,
    testKind: artifact.context.testKind,
    lane: artifact.context.lane,
    workspace,
  };
}

export function testTelemetryArtifactSourceKey(source: TestTelemetryArtifactSource) {
  return [source.producer, source.framework, source.testKind, source.lane, source.workspace].join(
    "\0",
  );
}

export function testTelemetryArtifactSourceLabel(source: TestTelemetryArtifactSource) {
  return `${source.producer}:${source.framework}/${source.testKind}/${source.lane}@${source.workspace}`;
}

export function countTestTelemetryArtifactSources(sources: readonly TestTelemetryArtifactSource[]) {
  const counts = new Map<string, { count: number; source: TestTelemetryArtifactSource }>();
  for (const source of sources) {
    const key = testTelemetryArtifactSourceKey(source);
    const current = counts.get(key);
    counts.set(key, { count: (current?.count ?? 0) + 1, source });
  }
  return counts;
}

function selectPrimaryArtifact(artifacts: readonly TestTelemetryArtifact[]) {
  return artifacts[0]
    ? artifacts.reduce((primary, candidate) => {
        const primaryDeclaresRunners = (primary.expectedArtifactSources?.length ?? 0) > 0;
        const candidateDeclaresRunners = (candidate.expectedArtifactSources?.length ?? 0) > 0;
        return Number(candidateDeclaresRunners) > Number(primaryDeclaresRunners) ||
          (candidateDeclaresRunners === primaryDeclaresRunners &&
            candidate.run.finishedAt > primary.run.finishedAt)
          ? candidate
          : primary;
      })
    : undefined;
}

function findMissingArtifactSources(
  expected: readonly ScopedArtifactSource[],
  observed: readonly ScopedArtifactSource[],
): MissingArtifactSource[] {
  const expectedCounts = countScopedArtifactSources(expected);
  const observedCounts = countScopedArtifactSources(observed);
  return [...expectedCounts.entries()].flatMap(
    ([key, { count: expectedCount, source, ciScope }]) => {
      const observedCount = observedCounts.get(key)?.count ?? 0;
      return observedCount < expectedCount
        ? [
            {
              source,
              ciScope,
              expectedCount,
              observedCount,
              missingCount: expectedCount - observedCount,
            },
          ]
        : [];
    },
  );
}

function scopedArtifactSource(
  artifact: TestTelemetryArtifact,
  source: TestTelemetryArtifactSource,
): ScopedArtifactSource {
  return { source, ciScope: artifactCiScope(artifact) };
}

function artifactCiScope(artifact: TestTelemetryArtifact): ArtifactCiScope {
  return {
    repository: artifact.ci.repository,
    workflowRunId: artifact.ci.workflowRunId,
    workflowRunAttempt: artifact.ci.workflowRunAttempt,
    ...(!artifact.ci.jobName ? {} : { jobName: artifact.ci.jobName }),
  };
}

function countScopedArtifactSources(sources: readonly ScopedArtifactSource[]) {
  const counts = new Map<string, ScopedArtifactSource & { count: number }>();
  for (const scoped of sources) {
    const key = `${ciScopeKey(scoped.ciScope)}\0${testTelemetryArtifactSourceKey(scoped.source)}`;
    const current = counts.get(key);
    counts.set(key, { ...scoped, count: (current?.count ?? 0) + 1 });
  }
  return counts;
}

function ciScopeKey(ciScope: ArtifactCiScope) {
  return [
    ciScope.repository,
    ciScope.workflowRunId,
    ciScope.workflowRunAttempt,
    ciScope.jobName ?? "",
  ].join("\0");
}
