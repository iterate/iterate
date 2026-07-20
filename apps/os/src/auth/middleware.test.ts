import { describe, expect, it } from "vitest";
import { isPublicAssetRequest, requestProjectId } from "./middleware.ts";

const projects = [
  { id: "prj_123", slug: "difference-engine" },
  { id: "prj_456", slug: "encoded project" },
];

describe("requestProjectId", () => {
  it("uses only a project the authenticated user can access", () => {
    expect(
      requestProjectId(
        new Request("https://os.iterate.com/projects/difference-engine/agents"),
        projects,
      ),
    ).toBe("prj_123");
    expect(
      requestProjectId(new Request("https://os.iterate.com/projects/not-mine"), projects),
    ).toBeUndefined();
  });

  it("accepts a same-origin referrer for server functions but ignores foreign origins", () => {
    expect(
      requestProjectId(
        new Request("https://os.iterate.com/_server", {
          headers: { referer: "https://os.iterate.com/projects/encoded%20project" },
        }),
        projects,
      ),
    ).toBe("prj_456");
    expect(
      requestProjectId(
        new Request("https://os.iterate.com/_server", {
          headers: { referer: "https://attacker.example/projects/difference-engine" },
        }),
        projects,
      ),
    ).toBeUndefined();
  });
});

// /assets/* requests must never run session auth (see the middleware comment:
// subresource token refreshes race the navigation's refresh and trip the auth
// server's refresh-token reuse detection). Sourcemap fetches are the observed
// offender — .js.map files are not in the static assets manifest, so devtools
// requests for them fall through to the worker.
describe("isPublicAssetRequest", () => {
  it("matches GET and HEAD requests under /assets/", () => {
    expect(isPublicAssetRequest(new Request("https://os.iterate.com/assets/main-abc123.js"))).toBe(
      true,
    );
    expect(
      isPublicAssetRequest(
        new Request("https://os.iterate.com/assets/stream-links-Q2NN3ESH.js.map"),
      ),
    ).toBe(true);
    expect(
      isPublicAssetRequest(
        new Request("https://os.iterate.com/assets/main-abc123.js", { method: "HEAD" }),
      ),
    ).toBe(true);
  });

  it("does not match app routes or non-read methods", () => {
    expect(isPublicAssetRequest(new Request("https://os.iterate.com/"))).toBe(false);
    expect(isPublicAssetRequest(new Request("https://os.iterate.com/assets"))).toBe(false);
    expect(isPublicAssetRequest(new Request("https://os.iterate.com/api/assets/x"))).toBe(false);
    expect(
      isPublicAssetRequest(
        new Request("https://os.iterate.com/assets/main-abc123.js", { method: "POST" }),
      ),
    ).toBe(false);
  });
});
