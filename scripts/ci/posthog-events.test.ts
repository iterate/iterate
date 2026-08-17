import { expect, it } from "vitest";
import { systemEvent } from "./posthog-events.ts";

it("uses a stable top-level PostHog UUID for retry and replay deduplication", () => {
  const first = systemEvent("ci test finished", "stable-source-occurrence", "ci-test:1", {});
  const replay = systemEvent("ci test finished", "stable-source-occurrence", "ci-test:1", {});
  const other = systemEvent("ci test finished", "different-occurrence", "ci-test:1", {});

  expect(first.uuid).toBe(replay.uuid);
  expect(first.uuid).not.toBe(other.uuid);
  expect(first.uuid).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  expect(first.properties.$insert_id).toBe("stable-source-occurrence");
});
