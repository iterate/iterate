// Which failed creates and updates of an OTLP destination ensure-resources.ts sends again
// (`preflightMetAStaleServer`). The first three details are what Cloudflare's API answered on the
// dev account on 2026-09-30.
import { expect, test } from "vitest";
import { CloudflareApiError } from "../../../scripts/lib/env-context.ts";
import { preflightMetAStaleServer } from "./ensure-resources.ts";

test.for([
  {
    name: "a preflight that met a workers.dev hostname Cloudflare does not route yet is sent again",
    error: refused("Pre-flight check failed: HTTP 404: error code: 1042\n"),
    again: true,
  },
  {
    name: "a preflight the previous version answered 503, the new secret unknown to it, is sent again",
    error: refused("Pre-flight check failed: HTTP 503: "),
    again: true,
  },
  {
    name: "a preflight the endpoint refused is not",
    error: refused("Pre-flight check failed: HTTP 401: unauthorized"),
    again: false,
  },
  {
    name: "a preflight the Worker itself answered not found is not",
    error: refused("Pre-flight check failed: HTTP 404: Not Found"),
    again: false,
  },
  {
    name: "a write refused before any preflight is not",
    error: refused("destination name already in use"),
    again: false,
  },
  {
    name: "a failure that is not the API's answer is not",
    error: new Error("Pre-flight check failed: HTTP 503: "),
    again: false,
  },
])("$name", ({ error, again }) => {
  expect(preflightMetAStaleServer(error)).toBe(again);
});

/** Cloudflare's API refusing a destination's create with `detail`, as `cf` throws it. */
function refused(detail: string) {
  return new CloudflareApiError("POST", "/workers/observability/destinations", 400, [
    { message: "Bad Request", detail },
  ]);
}
