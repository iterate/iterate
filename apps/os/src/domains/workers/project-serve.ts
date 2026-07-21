import {
  buildBudgetForRequest,
  WORKER_BUILDING_HEADER,
  workerBuildStatus,
} from "./worker-fetch-dispatch.ts";
import { WORKER_BUILD_FAILED_HEADER } from "./worker-serve-info.ts";
import { applyProjectWorkerOverlay, workerServeErrorResponse } from "./worker-serve-overlay.ts";

/** Long enough for warm-cache loads and quick bundles; past it, show the page. */
const PROJECT_HOST_BUILD_BUDGET_MS = 15_000;

type ProjectServeOutcome = "worker_build_failed" | "worker_building" | "worker_serve_error";

/**
 * Project ingress's serve envelope — the one place the project lane decides
 * what a browser sees around a dynamic worker:
 *
 * - the cold-build budget (a document navigation races only briefly, then
 *   gets the branded building page; see buildBudgetForRequest),
 * - classification of build-lifecycle errors into their stand-in pages
 *   (workerBuildStatus) and of pages bubbling back from inner hops into
 *   their observability outcomes,
 * - the @iterate overlay on served HTML documents,
 * - and the catch-all: any other serve failure answers the branded retrying
 *   page instead of escaping as a naked 500/1101 — a project host always
 *   shows platform chrome, however broken the build machinery is. The error
 *   goes to `onError` (logs/telemetry), never to the page.
 */
export async function serveProjectResponse({
  fetchWorker,
  onError,
  request,
}: {
  /** The runner dispatch, handed the budget the serve policy picked. */
  fetchWorker: (buildBudgetMs: number | undefined) => Promise<Response>;
  /** Report a swallowed non-build failure; the page itself stays generic. */
  onError: (error: unknown) => void;
  request: Request;
}): Promise<{ outcome: ProjectServeOutcome | null; response: Response }> {
  try {
    const response = await fetchWorker(
      buildBudgetForRequest(request, PROJECT_HOST_BUILD_BUDGET_MS),
    );
    // Inner hops answer build states as marked responses (a named error
    // cannot cross a fetch hop) — read the outcome off the headers.
    const outcome = response.headers.has(WORKER_BUILDING_HEADER)
      ? "worker_building"
      : response.headers.has(WORKER_BUILD_FAILED_HEADER)
        ? "worker_build_failed"
        : null;
    return { outcome, response: applyProjectWorkerOverlay(request, response) };
  } catch (error) {
    const buildStatus = workerBuildStatus(error);
    if (buildStatus !== null) return buildStatus;
    onError(error);
    return { outcome: "worker_serve_error", response: workerServeErrorResponse() };
  }
}
