import { describe, expect, it } from "vitest";
import { docsHealthResponse } from "./health.ts";

describe("docsHealthResponse", () => {
  it("proves the exact deployed Worker version to preview readiness checks", async () => {
    const response = docsHealthResponse({
      CF_VERSION_METADATA: { id: "version-123" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-iterate-worker-version")).toBe("version-123");
    await expect(response.text()).resolves.toBe("ok");
  });

  it("remains usable in local development without version metadata", () => {
    const response = docsHealthResponse({});

    expect(response.headers.get("x-iterate-worker-version")).toBe("unversioned");
  });
});
