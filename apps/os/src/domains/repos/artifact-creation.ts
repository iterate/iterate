/**
 * Create an Artifacts repository idempotently and report whether it has
 * already received a push.
 */
export async function getOrCreateArtifact(
  artifacts: {
    create(name: string, input: { setDefaultBranch: string }): Promise<unknown>;
    get(name: string): Promise<{ lastPushAt: string | null }>;
  },
  name: string,
  input: { defaultBranch: string },
): Promise<{ created: boolean; lastPushAt: string | null }> {
  try {
    await artifacts.create(name, { setDefaultBranch: input.defaultBranch });
    return { created: true, lastPushAt: null };
  } catch (error) {
    if ((error as { code?: string }).code !== "ALREADY_EXISTS") throw error;
  }

  const existing = await artifacts.get(name);
  return { created: false, lastPushAt: existing.lastPushAt };
}
