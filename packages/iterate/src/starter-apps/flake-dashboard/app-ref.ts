// The flake dashboard's physical identity and creation facts.
import type { StreamEventInput } from "../../processors/index.ts";
import type { StatefulDynamicWorkerRef } from "../../sdk.ts";

export const flakesStreamPath = "/flakes";

export const flakeDashboardWorkerRef = {
  className: "FlakeDashboardApp",
  durableWorkerKey: "app-flake-dashboard",
  path: "/",
  source: {
    createWorker: {
      entryPoint: "node_modules/iterate/dist/starter-apps/flake-dashboard/configured-worker.mjs",
      files: {
        include: ["package.json"],
        repoPath: "/repos/config",
        type: "repo",
      },
    },
  },
  type: "stateful",
} satisfies StatefulDynamicWorkerRef;

/**
 * The dashboard's birth certificate. Idempotency-keyed so every caller — the
 * worker's lazy initialization AND the CI reporter script, whichever appends
 * first — may offer it; the config values are immutable birth facts.
 */
export function flakeDashboardCreationEvents(config: {
  repository: { owner: string; repo: string };
  issueTitle: string;
  defaultBranch: string;
}): StreamEventInput[] {
  return [
    {
      type: "events.iterate.com/flakes/created",
      payload: { config },
      idempotencyKey: "flakes/created",
    },
  ];
}
