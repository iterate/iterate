/**
 * Ask Cloudflare Artifacts to clone a public GitHub repository directly.
 * The deterministic target name makes a completed retry equivalent to
 * success; the repo processor owns all further orchestration.
 */
export async function importGithubArtifact(
  artifacts: Pick<Artifacts, "import">,
  input: { branch: string; name: string; owner: string; repo: string },
): Promise<void> {
  try {
    await artifacts.import({
      source: {
        branch: input.branch,
        // Cloudflare documents depth as optional. Omitting it imports the
        // full history without transferring it through this Worker.
        // https://developers.cloudflare.com/artifacts/api/workers-binding/#importparams
        url: `https://github.com/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}.git`,
      },
      target: { name: input.name },
    });
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ALREADY_EXISTS") throw error;
  }
}
