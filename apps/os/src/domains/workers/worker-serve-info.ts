import { z } from "zod";

/**
 * The serve-side status contract of the fetch lane: what a client learns
 * about the dynamic worker build that answered it. Pure wire contract —
 * header names, the schema, and the stamping/stripping helpers. The
 * presentation built from it (the @iterate overlay, the building and
 * build-failed pages) lives in worker-serve-overlay.ts.
 *
 * Every project-host response carries `x-iterate-worker-serve` — platform-
 * authored (the runner overwrites whatever user code set) and deliberately
 * public: it says which build is serving ("fresh" at a commit) or that the
 * platform fell back to the previous good build (a newer commit is still
 * building, or its build failed — with the failure).
 */
export const WORKER_SERVE_HEADER = "x-iterate-worker-serve";

/** Marks a 500 as "the worker's build failed and no previous build exists" on
 * the fetch lane — the terminal sibling of WORKER_BUILDING_HEADER. */
export const WORKER_BUILD_FAILED_HEADER = "x-iterate-worker-build-failed";

/** A worker response can opt its HTML out of the overlay by setting this
 * header (any value) — an escape hatch, not a negotiation. Platform stand-in
 * pages set it themselves. */
export const OVERLAY_OPT_OUT_HEADER = "x-iterate-overlay";

export const WorkerServeInfo = z.object({
  /** The commit the SERVING artifact was built from (when known). */
  commitOid: z.string().optional(),
  failure: z
    .object({ at: z.string(), commitOid: z.string().optional(), message: z.string() })
    .optional(),
  /** Why a stale build is serving; absent when status is "fresh". */
  reason: z.enum(["building", "build-failed"]).optional(),
  status: z.enum(["fresh", "stale"]),
});
export type WorkerServeInfo = z.infer<typeof WorkerServeInfo>;

/**
 * Stamps the platform's serve info onto a worker response. Always deletes
 * first: the header is trusted platform output, so whatever user code set must
 * never survive — even when this hop has nothing to say. 101s pass through
 * untouched (a socket response cannot be reconstructed).
 */
export function withWorkerServeInfo(
  response: Response,
  info: WorkerServeInfo | undefined,
): Response {
  if (response.status === 101 || response.webSocket) return response;
  const stamped = new Response(response.body, response);
  stamped.headers.delete(WORKER_SERVE_HEADER);
  if (info !== undefined) stamped.headers.set(WORKER_SERVE_HEADER, JSON.stringify(info));
  return stamped;
}

/** The strip-only case, named: this hop cannot attest what build is serving
 * (stateful facets — the outer DO owns versioning), but a user-set header
 * must still die at the boundary. */
export function stripWorkerServeInfo(response: Response): Response {
  return withWorkerServeInfo(response, undefined);
}
