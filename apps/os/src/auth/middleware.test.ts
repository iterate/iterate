import { describe, expect, it } from "vitest";
import { isPublicAssetRequest } from "./middleware.ts";

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
