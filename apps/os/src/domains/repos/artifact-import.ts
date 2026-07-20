type GithubArtifactImport = {
  branch: string;
  depth: number;
  owner: string;
  repo: string;
};

/** Ask Cloudflare Artifacts to clone a public GitHub repository directly.
 * The deterministic target makes creation retry-safe: recovery after a
 * completed import but before `repo/ready` accepts that exact existing target
 * without ever cloning its contents into the Worker isolate. */
export async function importGithubArtifact(
  artifacts: Pick<Artifacts, "get" | "import">,
  input: GithubArtifactImport & { name: string },
  options: {
    pollAttempts?: number;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  try {
    await artifacts.import({
      source: {
        url: `https://github.com/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}.git`,
        branch: input.branch,
        depth: input.depth,
      },
      target: { name: input.name },
    });
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code !== "ALREADY_EXISTS" && code !== "IMPORT_IN_PROGRESS") throw error;

    const pollAttempts = options.pollAttempts ?? 60;
    const pollIntervalMs = options.pollIntervalMs ?? 500;
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      try {
        await artifacts.get(input.name);
        return;
      } catch (getError) {
        if ((getError as { code?: unknown })?.code !== "IMPORT_IN_PROGRESS") throw getError;
      }
      if (attempt + 1 < pollAttempts) await sleep(pollIntervalMs);
    }
    throw new Error(
      `Timed out waiting for Cloudflare Artifacts to import ${input.owner}/${input.repo} into "${input.name}".`,
    );
  }
}
