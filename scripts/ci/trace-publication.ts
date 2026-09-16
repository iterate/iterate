/** The status says the report is available; preview checks retain the test outcome. */
export function traceCommitStatus(
  previous: { description: string | null; target_url: string | null } | undefined,
  run: { headSha: string; createdAt: string; url: string },
) {
  // Store the source execution's time, not publication time: reconciliation can
  // revisit old runs. Normalized ISO dates sort chronologically in this format.
  const description = `Open trace · ${new Date(run.createdAt).toISOString()}`;
  if (previous?.target_url === run.url || (previous?.description || "") > description) return null;
  return {
    sha: run.headSha,
    context: "CI trace",
    state: "success" as const,
    description,
    target_url: run.url,
  };
}
