import { describe, expect, it } from "vitest";
import { rewriteLocalhost } from "./api.ts";

describe("rewriteLocalhost", () => {
  it("rewrites localhost to host.docker.internal", () => {
    expect(rewriteLocalhost("http://localhost:3000/api/orpc")).toBe(
      "http://host.docker.internal:3000/api/orpc",
    );
  });

  it("rewrites *.dev.iterate.com to host.docker.internal", () => {
    expect(rewriteLocalhost("https://dev-nick-os.dev.iterate.com/api/orpc")).toBe(
      "http://host.docker.internal:5173/api/orpc",
    );
  });

  it("preserves explicit port while rewriting *.dev.iterate.com", () => {
    expect(rewriteLocalhost("https://dev-nick-os.dev.iterate.com:4242/api/orpc")).toBe(
      "http://host.docker.internal:4242/api/orpc",
    );
  });

  it("uses detected dev port when rewriting *.dev.iterate.com without explicit port", () => {
    expect(
      rewriteLocalhost("https://dev-nick-os.dev.iterate.com/api/orpc", {
        devIteratePort: 5180,
      }),
    ).toBe("http://host.docker.internal:5180/api/orpc");
  });

  it("does not rewrite non-dev hostnames", () => {
    expect(rewriteLocalhost("https://iterate.com/api/orpc")).toBe("https://iterate.com/api/orpc");
  });
});
