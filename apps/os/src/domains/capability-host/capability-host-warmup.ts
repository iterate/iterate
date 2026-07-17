const MAX_CAPABILITY_HOST_WARMUP_DEPTH = 32;

/**
 * Warm one capability host and the explicit ancestor graph it declares.
 *
 * Typechecker warmup starts in parallel with the local journal catch-up. The
 * ancestor cannot be selected until that catch-up exposes the durable birth
 * certificate; once selected, only that declared host is contacted. The
 * visited path makes corrupt cycles and unbounded chains fail explicitly
 * instead of turning boot into a recursive Durable Object deadlock.
 */
export async function warmCapabilityHostDependencies(input: {
  ancestorPath(): Promise<string | null>;
  catchUp(): Promise<void>;
  path: string;
  visitedScopePaths: string[];
  warmAncestor(ancestorPath: string, visitedScopePaths: string[]): Promise<void>;
  warmTypechecker(): Promise<void>;
}): Promise<void> {
  const { path, visitedScopePaths } = input;
  if (visitedScopePaths.includes(path)) {
    throw new Error(
      `capability-host warmup ancestor cycle: ${[...visitedScopePaths, path].join(" -> ")}`,
    );
  }
  if (visitedScopePaths.length >= MAX_CAPABILITY_HOST_WARMUP_DEPTH) {
    throw new Error(
      `capability-host warmup ancestor depth exceeds ${MAX_CAPABILITY_HOST_WARMUP_DEPTH}: ${[
        ...visitedScopePaths,
        path,
      ].join(" -> ")}`,
    );
  }
  const nextVisitedScopePaths = [...visitedScopePaths, path];

  // Both promises are constructed before either is awaited: compiler
  // instantiation begins at host boot while the journal is being loaded.
  const typecheckerWarmup = Promise.resolve().then(() => input.warmTypechecker());
  const ancestorWarmup = (async () => {
    await input.catchUp();
    const ancestorPath = await input.ancestorPath();
    if (ancestorPath === null) return;
    if (ancestorPath === path) {
      throw new Error(`capability-host ${JSON.stringify(path)} cannot be its own ancestor`);
    }
    await input.warmAncestor(ancestorPath, nextVisitedScopePaths);
  })();

  await Promise.all([typecheckerWarmup, ancestorWarmup]);
}
