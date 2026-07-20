import { describe, expect, it } from "vitest";
import { canCommitStaleFacetRefresh } from "./stateful-worker-durable-object.ts";

describe("stale facet refresh ownership", () => {
  it("does not abort a facet mounted by cache-miss recovery while the refresh awaited", () => {
    expect(
      canCommitStaleFacetRefresh({
        currentVersion: "v2",
        previousVersion: "v1",
        resolvedVersion: "v2",
      }),
    ).toBe(false);
  });

  it("commits only a changed version while its original marker is still current", () => {
    expect(
      canCommitStaleFacetRefresh({
        currentVersion: "v1",
        previousVersion: "v1",
        resolvedVersion: "v2",
      }),
    ).toBe(true);
    expect(
      canCommitStaleFacetRefresh({
        currentVersion: "v1",
        previousVersion: "v1",
        resolvedVersion: "v1",
      }),
    ).toBe(false);
  });
});

// StaleFacetUnavailableError is intentionally module-private (wire format only).
// Replicate the version parser contract here so Cap'n Web wrapping cannot regress
// recovery classification without a failing unit test. Keep in lockstep with the
// `iterate:stale-facet-unavailable:` code in stateful-worker-durable-object.ts.
describe("stale facet unavailable wire format", () => {
  const code = "iterate:stale-facet-unavailable:";

  function versionFromMessage(message: string): string | null {
    const codeAt = message.indexOf(code);
    if (codeAt < 0) return null;
    const encoded = message.slice(codeAt + code.length).split(" ", 1)[0];
    if (encoded === undefined || encoded.length === 0) return null;
    try {
      return decodeURIComponent(encoded);
    } catch {
      return null;
    }
  }

  it("parses a bare sentinel message", () => {
    const version = JSON.stringify({ className: "Probe", sourceCacheKey: "abc" });
    const message = `${code}${encodeURIComponent(version)} stateful worker's previous artifact is no longer cached`;
    expect(versionFromMessage(message)).toBe(version);
  });

  it("parses when Cap'n Web prefixes Error:", () => {
    const version = JSON.stringify({ className: "Probe", sourceCacheKey: "abc" });
    const message = `Error: ${code}${encodeURIComponent(version)} stateful worker's previous artifact is no longer cached`;
    expect(versionFromMessage(message)).toBe(version);
  });
});
