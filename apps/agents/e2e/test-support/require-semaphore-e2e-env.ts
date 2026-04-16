/**
 * Tunnel-lease e2e requires `SEMAPHORE_API_TOKEN` and `SEMAPHORE_BASE_URL` from Doppler (e.g. `agents`
 * inheriting `_shared`). Project selection is via repo `doppler.yaml` + `doppler run` from `apps/agents`
 * (after `doppler setup` for that path). If these are missing, fix Doppler config — not `APP_CONFIG`.
 */
export function requireSemaphoreE2eEnv(env: NodeJS.ProcessEnv): void {
  if (!env.SEMAPHORE_API_TOKEN?.trim() || !env.SEMAPHORE_BASE_URL?.trim()) {
    throw new Error(
      "SEMAPHORE_API_TOKEN and SEMAPHORE_BASE_URL are required. Run `pnpm test:e2e` from `apps/agents` with `doppler run` so `doppler.yaml` selects the `agents` project and injects secrets (typically from `_shared`).",
    );
  }
}
