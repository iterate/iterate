/**
 * Create an Artifacts repository idempotently and finish obligations that
 * must precede its first push. An existing seeded repository is already past
 * this boundary and must not depend on those setup services during lookup.
 */
export async function getOrCreateArtifact(
  artifacts: {
    create(name: string, input: { setDefaultBranch: string }): Promise<unknown>;
    get(name: string): Promise<{ lastPushAt: string | null }>;
  },
  name: string,
  input: { beforeFirstPush: () => Promise<void>; defaultBranch: string },
): Promise<{ created: boolean; lastPushAt: string | null }> {
  try {
    await artifacts.create(name, { setDefaultBranch: input.defaultBranch });
    await input.beforeFirstPush();
    return { created: true, lastPushAt: null };
  } catch (error) {
    if ((error as { code?: string }).code !== "ALREADY_EXISTS") throw error;
  }

  const existing = await artifacts.get(name);
  if (existing.lastPushAt === null) {
    await input.beforeFirstPush();
  }
  return { created: false, lastPushAt: existing.lastPushAt };
}
