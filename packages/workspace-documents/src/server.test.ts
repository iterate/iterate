import { describe, expect, test } from "vitest";
import { projectCredentialAddress } from "./server.ts";

describe("projectCredentialAddress", () => {
  test("accepts the preferred slug-addressed project secret", () => {
    expect(
      projectCredentialAddress({
        type: "project-secret",
        projectSlug: "design-review",
        secret: "secret",
      }),
    ).toBe("design-review");
  });

  test("accepts the stable-id machine lane", () => {
    expect(
      projectCredentialAddress({
        type: "project-secret",
        projectId: "prj_123",
        secret: "secret",
      }),
    ).toBe("prj_123");
  });
});
