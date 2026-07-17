import { describe, expect, it } from "vitest";
import { itxEntrypointProps, scopeFromItxEntrypointProps } from "./utils.ts";

describe("itx entrypoint authority props", () => {
  it("preserves the host-minted purpose while normalizing the scope", () => {
    expect(
      itxEntrypointProps({
        path: "agents/ada",
        projectId: "prj_123",
        purpose: "stream-delivery",
      }),
    ).toEqual({
      path: "/agents/ada",
      projectId: "prj_123",
      purpose: "stream-delivery",
    });
  });

  it("rejects old or forged bindings with no recognized purpose", () => {
    expect(() =>
      scopeFromItxEntrypointProps({
        path: "/",
        projectId: "prj_123",
      } as never),
    ).toThrow(/purpose/);
  });
});
