// The dial contract — the control plane dialling the project worker (two transports, one behavior:
// same-account service binding, or cross-account HTTP POST /serve). This is THE shared home the two
// hand-synced copies (project-worker/src/index.ts + control-plane/src/ingress.ts) pointed at.
//
// CALLER/APP/CP_ORIGIN are handed INTO the sandbox (trusted, set by the control plane);
// DIAL_SECRET/PROJECT_ID/PATH are the runner ENVELOPE and must NEVER reach the sandbox.

export const CALLER_HEADER = "x-iterate-caller";
export const APP_HEADER = "x-iterate-app";
// Trusted, rides into the sandbox — read by the config worker for the login URL.
export const CP_ORIGIN_HEADER = "x-iterate-cp-origin";
export const DIAL_SECRET_HEADER = "x-iterate-dial-secret";
export const PROJECT_ID_HEADER = "x-iterate-project-id";
export const PATH_HEADER = "x-iterate-path";

/** The non-secret caller identity + THIS project's membership, stamped through the dial (unforgeable by
 *  the browser — the control plane overwrites it on every dial). A private app reads `member` via itx.auth. */
export interface StampedCaller {
  actor: string;
  email: string;
  member: boolean;
  role: string | null;
}
