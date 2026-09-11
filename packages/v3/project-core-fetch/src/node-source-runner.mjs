import { runInNewContext } from "node:vm";

/**
 * Deliberately Node-only and unsafe for untrusted sources. Production hosts
 * must replace this with a prebuilt-module loader behind a trust boundary.
 */
export function evaluateNodeWorkerSource({ source, request, api }) {
  return runInNewContext(`(async () => { ${source} })()`, { Response, URL, request, api });
}
