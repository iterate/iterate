import { describe, expect, it } from "vitest";
import { authorLabel } from "./collab-redline.ts";

describe("authorLabel", () => {
  it("agents read as agent", () => {
    expect(authorLabel("external")).toBe("agent");
  });
  it("named ids surface the full display slug — the random suffix never bleeds in", () => {
    expect(authorLabel("u-usr-jonas-xlo98p")).toBe("usr jonas");
    expect(authorLabel("u-jonas-templestein-a1b2c3")).toBe("jonas templestein");
  });
  it("unrecognized ids are someone", () => {
    expect(authorLabel("web-abcdef")).toBe("someone");
  });
});
