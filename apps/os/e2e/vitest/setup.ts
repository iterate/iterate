/**
 * itx e2e environment defaults.
 *
 * The itx e2e suites are URL-driven black boxes: point APP_CONFIG_BASE_URL at
 * any live os deployment (vite dev server or deployed worker). When unset, the
 * local dev server discovery file provides the target — same resolution the
 * rest of the os e2e lane uses. The deployment serves the itx capnweb
 * surface at /api.
 */
import { fileURLToPath } from "node:url";
import { resolveBaseUrl } from "../test-support/dev-server.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));

const baseUrl = resolveBaseUrl(appRoot);
if (baseUrl) process.env.APP_CONFIG_BASE_URL = baseUrl;

// A stream-delivery timeout under concurrent load can surface as an UNHANDLED
// rejection rather than inside a test's await: when one test's `waitForEvent`
// RPC rejects (server-side `Timed out waiting for stream event` /
// `waitUntilEvent timed out` / `waitUntilProcessed timed out`), the promise for
// a *sibling* concurrent test — or
// a background subscription whose owning test already moved on — rejects into
// the void as capnweb's read loop drains. Node's default is to CRASH the vitest
// worker on that, which produces zero test output and BYPASSES the CI
// `retry: 1` safety net entirely (flake survey 2026-07-04: this took down
// #1664/#1665 with a bare `Node.js v24…` + exit 1, while #1666 — same flake but
// surfaced inside an await — recovered on retry).
//
// Swallow ONLY that known-transient signature so the worker survives: the test
// that actually awaited the wait still fails normally and gets retried, turning
// a suite-killing crash into an ordinary (usually retry-absorbed) failure.
// Every other unhandled rejection is re-thrown, which Node escalates to an
// uncaughtException — preserving the crash-on-real-bug behaviour.
const TRANSIENT_STREAM_WAIT =
  /Timed out waiting for stream event|waitUntilEvent timed out|waitUntilProcessed timed out/i;
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (TRANSIENT_STREAM_WAIT.test(message)) {
    console.warn(
      `[e2e] swallowed dangling stream-wait rejection (keeps retry:1 alive): ${message}`,
    );
    return;
  }
  throw reason;
});
