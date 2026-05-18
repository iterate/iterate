export function repoArtifactName(input: { projectId: string; repoSlug: string }) {
  return `${input.projectId}--${input.repoSlug}`;
}
