/** Trusted build metadata stamped by OS onto dynamic-worker responses. */
export const WORKER_SERVE_HEADER = "x-iterate-worker-serve";

/** Marks the terminal build-failed page on the fetch lane. */
export const WORKER_BUILD_FAILED_HEADER = "x-iterate-worker-build-failed";

/** Marks ingress's catch-all page for a platform-side serve failure. */
export const WORKER_SERVE_ERROR_HEADER = "x-iterate-worker-serve-error";

/** A worker response can opt its HTML out of the iterate overlay. */
export const OVERLAY_OPT_OUT_HEADER = "x-iterate-overlay";

/** Replace any user-authored copy before stamping trusted platform metadata. */
export function withWorkerCommit(response: Response, commitOid: string | undefined): Response {
  if (response.status === 101 || response.webSocket) return response;
  const stamped = new Response(response.body, response);
  stamped.headers.delete(WORKER_SERVE_HEADER);
  if (commitOid !== undefined) stamped.headers.set(WORKER_SERVE_HEADER, commitOid);
  return stamped;
}
