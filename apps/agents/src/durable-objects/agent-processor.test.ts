import { describe, test } from "vitest";

describe.skip("legacy IterateAgent processor", () => {
  test("kept as a skipped marker while the old implementation is removed", () => {
    /*
     * The old monolithic IterateAgent processor has been deleted. Its behavior
     * is being replaced by separate Webchat, Agent, and Codemode stream
     * processors under `src/stream-processors`.
     *
     * Keep this skipped suite briefly so test reports make the quarantine
     * visible while the e2e coverage is moved to the new runner architecture.
     */
  });
});
