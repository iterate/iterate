// client.ts — the workshop's client library. `withItx` is the runtime-specific
// entry point for holding an itx context from OUTSIDE the platform (a Node
// program, this harness, your laptop daemon). It mirrors the production
// `apps/os/src/itx/client.ts`.
//
// It returns the NAKED capnweb session stub — there is deliberately no
// client-side path proxy (Step 6): the bare stub already pipelines deep dotted
// paths (`itx.slack.chat.postMessage(...)`) into one message. The session is
// Disposable, so `using itx = withItx(...)` closes the socket at scope end (and
// any live capability this connection provided is gone when it drops — live caps
// are session-bound).
//
// Node-only by import (it passes a `ws` socket into capnweb). A browser would
// hit the same `/itx` endpoint; the React ergonomics are the other half of
// Step 13 (still TODO).

import { connect } from "./client-lib.ts";

export type WithItxInput = {
  /** Worker base url. Defaults to ITX_BASE or http://127.0.0.1:8787. */
  baseUrl?: string;
  /**
   * Which context to open — in production a context is a project id + a path
   * (Step 12), and you pass it here. In this workshop it selects the `?ctx=<name>`
   * context; omitted = the shared "itx" context.
   *
   * (Production's withItx also takes a `token` and authenticates the socket; the
   * workshop has no auth yet — that's the Step 12 security layer.)
   */
  context?: string;
};

export function withItx<T = any>(input: WithItxInput = {}): T {
  const base = input.baseUrl ?? process.env.ITX_BASE ?? "http://127.0.0.1:8787";
  const wsBase = base.replace(/^http/, "ws");
  const url = `${wsBase}/itx${input.context ? `?ctx=${encodeURIComponent(input.context)}` : ""}`;
  return connect<T>(url);
}
