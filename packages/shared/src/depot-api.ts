// depot-api.ts — THE ONE CLIENT OF DEPOT'S CI API, runtime-neutral (no `node:` imports), so the CI
// scripts (scripts/ci/depot.ts) and the ci-reports Worker (apps/ci-reports) call it alike.
import { CI_HTTP, fetchRetryingPlatformFailures, HttpAnswerError } from "iterate/platform-retry";

/** Iterate's Depot organization, which runs every workflow in .depot/workflows (docs/depot-ci.md). */
export const DEPOT_ORG = "0p91s0lz49";

/**
 * One call to Depot's CI API, the Connect JSON protocol the Depot CLI itself speaks. The methods and
 * their fields are in https://github.com/depot/cli/blob/main/proto/depot/ci/v1/ci.proto (JSON uses
 * the camelCase field names). `token` is an organization API token (`DEPOT_CI_TELEMETRY_TOKEN`).
 *
 * A read (`Get…`, `List…`) that Depot answers with a 5xx or a 429, or whose connection fails, is
 * asked again on CI_HTTP's schedule, with a `depot.platform-failure-retry` warn per repeat
 * (`fetchRetryingPlatformFailures`). Any other 4xx is an answer about the request and fails at once
 * as an HttpAnswerError with its status, as does any other method (Connect sends every call as a
 * POST, so only the name says it changes nothing). A single 500 on GetJobAttemptLogs is enough to
 * fail a trace job without the repeat.
 */
export async function depotCiApi(
  method: string,
  body: object,
  token: string,
  options: { fetch?: typeof fetch } = {},
): Promise<unknown> {
  const { fetch: fetchImpl = fetch } = options;
  const response = await fetchRetryingPlatformFailures(
    `Depot ${method}`,
    (signal) =>
      fetchImpl(`https://api.depot.dev/depot.ci.v1.CIService/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-depot-org": DEPOT_ORG,
        },
        body: JSON.stringify(body),
        signal,
      }),
    {
      area: "depot",
      schedule: CI_HTTP,
      idempotent: /^(Get|List)[A-Z]/.test(method),
    },
  );
  if (response.ok) return response.json();
  throw new HttpAnswerError(
    `Depot ${method} answered HTTP ${response.status}: ${await response.text()}`,
    response,
  );
}
