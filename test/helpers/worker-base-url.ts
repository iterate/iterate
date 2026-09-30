/** The port of the local OS worker Playwright starts when `WORKER_BASE_URL` is unset. */
export const localWorkerPort = Number(process.env.WORKER_PORT || 8788);

/**
 * The OS under test, as for the vitest e2e suite: `WORKER_BASE_URL`'s origin, else the local
 * worker. The config (the `os` projects' baseURL), suite setup and every test worker read it here,
 * so each process derives the same origin from the same environment.
 */
export const workerBaseUrl = new URL(
  process.env.WORKER_BASE_URL || `http://localhost:${localWorkerPort}`,
).origin;
