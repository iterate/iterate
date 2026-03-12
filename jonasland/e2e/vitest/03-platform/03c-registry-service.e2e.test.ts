import { describe } from "vitest";
import { test } from "../../test-support/e2e-test.ts";

/**
 * Legacy migration notes from deleted
 * `jonasland/e2e/tests/clean/registry-caddy-reload.e2e.test.ts` and the
 * registry-heavy parts of `jonasland/e2e/tests/clean/caddy-host-routing.e2e.test.ts`.
 *
 * The old tests proved more than "registry returns something":
 *
 * - dynamic services such as `example.iterate.localhost` self-register after
 *   their pidnap config is applied
 * - `registryService.getPublicURL(...)` changes after `ITERATE_INGRESS_HOST`
 *   and `ITERATE_INGRESS_ROUTING_TYPE` are updated
 * - internal, subdomain, and dunder host forms all converge to the intended
 *   upstream after registry/caddy reloads settle
 * - `/api/echo` reflects the incoming `Host`
 * - `X-Forwarded-Host` should override `Host` for routing, matching ingress
 *   worker behavior
 *
 * When porting, keep the retry loops explicit around route registration and
 * public URL resolution because registry reloads briefly interrupt requests.
 */
const cases = [
  {
    id: "docker" as const,
    tags: ["docker"] as const,
  },
  {
    id: "fly" as const,
    tags: ["fly", "slow"] as const,
  },
];

describe("registry service", () => {
  describe.each(cases)("$id", ({ tags }) => {
    // Legacy route publication coverage started `exampleServiceManifest`,
    // waited for `registryService.routes.list({})`, and only then exercised the
    // host-routed paths.
    test.todo("service routes become visible to the registry", {
      tags: [...tags],
    });
    // The deleted test compared pre-change and post-change public URLs after
    // mutating `ITERATE_INGRESS_HOST` and routing mode at runtime.
    test.todo("public URL resolution matches the configured ingress rules", {
      tags: [...tags],
    });
    // Keep the host matrix from the legacy suite in mind here:
    // internal, subdomain, dunder, and the `X-Forwarded-Host` override path.
    test.todo("registry changes cause caddy routing to converge correctly", {
      tags: [...tags],
    });
  });
});
