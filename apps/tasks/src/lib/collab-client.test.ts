import { describe, expect, test } from "vitest";
import { CollabConnection } from "./collab-client.ts";

describe("CollabConnection.reseed", () => {
  test("resets the confirmed baseline AND mints a fresh client identity", () => {
    const instance = new CollabConnection("c1", "/repos/config", "/tasks/x.md");
    instance.confirmed = 7;
    const before = instance.clientId;
    instance.reseed({ content: "fresh", epoch: "e2", version: 42 });
    expect(instance.epoch).toBe("e2");
    expect(instance.confirmed).toBe(0);
    // Same-epoch history-miss recovery restarts clientSeq at 0; reusing the
    // old clientId would collide with server-acked (clientId, seq) pairs and
    // every carried edit would be silently deduped away.
    expect(instance.clientId).not.toBe(before);
  });
});
