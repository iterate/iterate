import { describe } from "vitest";
import { test } from "../../test-support/e2e-test.ts";

/**
 * Legacy migration notes from deleted `jonasland/e2e/tests/clean/example-orpc.e2e.test.ts`.
 *
 * That file exercised the example service as a real platform workload:
 *
 * - apply `exampleServiceManifest` through pidnap
 * - wait for the process to become healthy and for
 *   `example.iterate.localhost` to appear in registry routes
 * - hit `/api/things/ping` through host routing until it stabilizes
 * - exercise CRUD over `/api/things`
 * - call `/api/things/test/delayed-publish`
 * - verify the delayed event later appears through registry-hosted streams
 *
 * The old test intentionally used the service through caddy host routing rather
 * than calling internals directly. Keep that boundary when porting so this file
 * remains a platform-facing test, not a unit test for the example app.
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

describe("example service", () => {
  describe.each(cases)("$id", ({ tags }) => {
    test.todo("example service starts via pidnap and registers its host route", {
      tags: [...tags],
    });
    test.todo("example service CRUD routes work through caddy host routing", {
      tags: [...tags],
    });
    test.todo("example service delayed publish becomes visible in events service", {
      tags: [...tags],
    });
  });
});
