import { describe } from "vitest";
import { test } from "../../test-support/e2e-test.ts";

/**
 * Legacy migration notes from deleted `jonasland/e2e/tests/clean/events-firehose.e2e.test.ts`.
 *
 * That file was a concrete "append then observe" test, not just a smoke check:
 *
 * - create a deployment and wait for it to become alive
 * - open `/api/firehose` on `events.iterate.localhost` before appending
 * - append an event with a unique `path`, `type`, and random marker payload
 * - parse the SSE stream line-by-line until a `data:` frame matches the marker
 * - assert the observed event keeps the expected type and normalized path
 *
 * When porting, prefer keeping the event path and marker unique per test so the
 * suite can stay concurrent without accidental cross-talk between cases.
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

describe("events service", () => {
  describe.each(cases)("$id", ({ tags }) => {
    // Legacy append coverage used `deployment.eventsService.append(...)` and
    // a follow-up read path, not just a superficial health check.
    test.todo("events can be appended and later observed", {
      tags: [...tags],
    });
    // Legacy firehose coverage opened the stream first, then appended, then
    // decoded `data:` SSE frames until the unique marker was seen.
    test.todo("firehose subscribers receive appended events", {
      tags: [...tags],
    });
    // The old example-service flow also relied on delayed event publication, so
    // this TODO should eventually cover workflow-like behavior, not only raw IO.
    test.todo("event workflows behave correctly across provider cases", {
      tags: [...tags],
    });
  });
});
