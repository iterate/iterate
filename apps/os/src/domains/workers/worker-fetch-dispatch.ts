import { z } from "zod";
import { isRepoNotSeededError } from "../repos/utils.ts";
import type { DynamicWorkerRef } from "./schemas.ts";
import { DynamicWorkerRef as WorkerRefSchema } from "./schemas.ts";
import { isWorkerBuildFailedError } from "./artifact-store.ts";
import { isWorkerBuildInProgressError } from "./worker-loader.ts";
import { OVERLAY_OPT_OUT_HEADER, WORKER_BUILDING_HEADER } from "./worker-serve-info.ts";
import { workerBuildFailedResponse, workerBuildingPageHtml } from "./worker-serve-overlay.ts";

/**
 * The fetch lane: how HTTP (and only HTTP) reaches dynamic workers.
 *
 * workerd grants protocol semantics — WebSocket upgrades, streaming — to
 * exactly one place: the distinguished `fetch` handler on its two real object
 * kinds, WorkerEntrypoint and DurableObject classes (facets are DO-hosted),
 * reached through real stubs (service bindings, `ctx.exports` loopback
 * entrypoints, Worker Loader entrypoint stubs, DO stubs, facet stubs). Those
 * objects are always top-of-stack, so the platform can terminate an upgrade
 * there. Everything else — the itx capability tree, dotted paths, flattened
 * `invokeCapability` dispatch — is an RPC overlay whose arguments and results
 * are SERIALIZED, and a socket is the one thing serialization cannot carry
 * (workerd: `DataCloneError: Could not serialize object of type
 * "WebSocket"`). A capability method named `fetch` is just a method.
 *
 * So HTTP into a dynamic worker rides this lane: a chain of real stub
 * fetches from ingress into the app. Real fetch has no argument channel
 * besides the request itself, so the target ref rides in this header (the
 * role `invokeCapability`'s `ref` argument plays on the RPC side). It is
 * internal: OS ingress strips it at the trust boundary
 * (`stripInternalHeaders`), and each receiver removes it before the request
 * reaches dynamic worker code.
 *
 * The full model, hop by hop: docs/dynamic-worker-dispatch.md.
 */
export const WORKER_FETCH_DISPATCH_HEADER = "x-iterate-worker-dispatch";

/** The dispatch instruction a fetch-native hop needs: which worker to load
 * (same ref shape as `project.workers.get`) and the caller's build budget. */
type WorkerFetchDispatch = {
  buildBudgetMs?: number;
  ref: DynamicWorkerRef;
};

const WorkerFetchDispatch = z.strictObject({
  buildBudgetMs: z.number().int().positive().optional(),
  ref: WorkerRefSchema,
});

/** Whether a request asks for a WebSocket upgrade — the marker that dispatch
 * must stay on fetch-native hops end to end. */
export function isWebSocketUpgradeRequest(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/**
 * Marks a 503 as "the worker is cold-building" on the fetch lane, where a
 * named error cannot cross the hop the way it does over RPC. Routers that
 * want their own building page can match on it; passing the response through
 * untouched already gives browsers the auto-refresh page and WebSocket
 * clients a retryable close.
 */
export { WORKER_BUILDING_HEADER };

/** The one cold-build response every fetch-lane hop answers with: a polling
 * page for browsers (meta refresh for no-JS clients), retry-after + the
 * marker header for programmatic clients. */
export function workerBuildingResponse(): Response {
  return new Response(workerBuildingPageHtml(WORKER_BUILDING_HEADER), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "retry-after": "2",
      [WORKER_BUILDING_HEADER]: "1",
      // Platform chrome, not a worker page — the overlay stays out.
      [OVERLAY_OPT_OUT_HEADER]: "1",
    },
    status: 503,
  });
}

/**
 * The fetch lane's one error classifier: named build-lifecycle errors become
 * their stand-in pages and a modeled observability outcome (they cannot cross
 * a fetch hop the way they cross RPC), anything else is the caller's to
 * rethrow. Every fetch-lane hop — ingress, ItxEntrypoint, the stateful worker
 * DO — answers through this so a new serve-side state is added in exactly one
 * place.
 */
export function workerBuildStatus(
  error: unknown,
): { outcome: "worker_build_failed" | "worker_building"; response: Response } | null {
  // RepoNotSeededError: a browser can reach a project host inside the
  // project's BIRTH window — the config repo's stream exists before its seed
  // commit lands (../repos/utils.ts), so the source resolve answers "not
  // seeded YET, retry". That is the building page's exact contract (poll,
  // self-heal into the app); letting it escape crashed the worker with a
  // Cloudflare 1101 on a fresh project's first app request (observed live on
  // preview e2e, 2026-07-17).
  if (isRepoNotSeededError(error) || isWorkerBuildInProgressError(error)) {
    return { outcome: "worker_building", response: workerBuildingResponse() };
  }
  if (isWorkerBuildFailedError(error)) {
    return { outcome: "worker_build_failed", response: workerBuildFailedResponse(error) };
  }
  return null;
}

export function withWorkerFetchDispatchHeader(
  request: Request,
  dispatch: WorkerFetchDispatch,
): Request {
  const headers = new Headers(request.headers);
  headers.set(WORKER_FETCH_DISPATCH_HEADER, JSON.stringify(dispatch));
  return new Request(request, { headers });
}

/**
 * Reads and strips the dispatch header. Returns null when the header is
 * absent; throws on a malformed value (an internal caller composed it, so a
 * parse failure is a bug, not user input).
 */
export function takeWorkerFetchDispatch(
  request: Request,
): { dispatch: WorkerFetchDispatch; request: Request } | null {
  const raw = request.headers.get(WORKER_FETCH_DISPATCH_HEADER);
  if (raw === null) return null;
  const dispatch = WorkerFetchDispatch.parse(JSON.parse(raw));
  const headers = new Headers(request.headers);
  headers.delete(WORKER_FETCH_DISPATCH_HEADER);
  return { dispatch, request: new Request(request, { headers }) };
}
