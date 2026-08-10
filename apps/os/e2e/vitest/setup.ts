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
import { afterAll } from "vitest";
import {
  cloudflareWorkerVersionOverrideHeaders,
  createCloudflareWorkerVersionOverrideFetch,
} from "@iterate-com/shared/test-support/cloudflare-worker-version-overrides";
import { resolveBaseUrl } from "../test-support/dev-server.ts";
import { recycleLocalDevServerIfPressured } from "../test-support/global-setup.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));

const baseUrl = resolveBaseUrl(appRoot);
if (baseUrl) process.env.APP_CONFIG_BASE_URL = baseUrl;

// The suite also makes direct HTTP requests (OS routes, project hostnames,
// and fixture Workers) alongside its itx WebSockets. Pin those to the same
// freshly deployed fleet instead of proving whichever version percentage
// routing happens to choose during global propagation.
if (Object.keys(cloudflareWorkerVersionOverrideHeaders(process.env)).length > 0) {
  const nativeFetchKey: unique symbol = Symbol.for("iterate.osE2e.nativeFetch");
  const stash = globalThis as typeof globalThis & { [nativeFetchKey]?: typeof fetch };
  const nativeFetch = (stash[nativeFetchKey] ??= globalThis.fetch.bind(globalThis));
  globalThis.fetch = createCloudflareWorkerVersionOverrideFetch(nativeFetch, process.env);
}

// Between files, recycle the local dev server if its workerd RSS has grown past
// the limit — the long local suite creates many project isolates that local
// workerd never evicts, so this turns the monotonic climb toward the ~4GB cage
// into a sawtooth and the suite survives instead of SIGABRT-ing mid-run. No-op
// in CI / against a deployed target and on non-pressured runs.
afterAll(recycleLocalDevServerIfPressured);
