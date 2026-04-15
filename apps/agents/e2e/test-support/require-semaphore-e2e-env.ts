/**
 * Agents e2e tests that talk to Semaphore (tunnel leases) require these variables.
 * Run via `pnpm test:e2e` from `apps/agents` so Doppler injects them from the `agents` project.
 */
export function requireSemaphoreE2eEnv(env: NodeJS.ProcessEnv): void {
  if (!env.SEMAPHORE_API_TOKEN?.trim() || !env.SEMAPHORE_BASE_URL?.trim()) {
    throw new Error(
      "SEMAPHORE_API_TOKEN and SEMAPHORE_BASE_URL are required for this e2e suite (configure in Doppler `agents`, often inherited from `_shared`). Run: `pnpm test:e2e` from `apps/agents`.",
    );
  }
}
