import { describe, expect, it } from "vitest";
import { expectedSearchSyncSkipReason } from "./search-sync-outcome.ts";

describe("expectedSearchSyncSkipReason", () => {
  it("models missing instances during birth and Cloudflare's documented sync cooldown", () => {
    expect(expectedSearchSyncSkipReason(new Error("ai_search_not_found"))).toBe("instance-missing");
    expect(expectedSearchSyncSkipReason(new Error("7020: sync_in_cooldown"))).toBe("sync-cooldown");
  });

  it("does not hide unrelated rate limits or unknown AI Search failures", () => {
    expect(expectedSearchSyncSkipReason(new Error("too many requests"))).toBeNull();
    expect(expectedSearchSyncSkipReason(new Error("ai_search_internal_error"))).toBeNull();
  });
});
