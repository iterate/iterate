import { isRepoNotSeededError } from "../repos/utils.ts";
import { workerBuildingResponse, workerBuildStatusResponse } from "./worker-fetch-dispatch.ts";

/**
 * Classify source-availability failures for the default project worker.
 *
 * Unlike an arbitrary repo-backed worker, this worker always comes from the
 * platform-seeded config repo. Project creation intentionally exposes the
 * project before that repo's first commit lands, so `RepoNotSeededError` is a
 * bounded bootstrap state on this one route. Keep the exception here: generic
 * worker dispatch must not turn a permanently empty user repo into an endless
 * "building" page.
 */
export function projectWorkerFetchStatusResponse(error: unknown): Response | null {
  if (isRepoNotSeededError(error)) return workerBuildingResponse();
  return workerBuildStatusResponse(error);
}
