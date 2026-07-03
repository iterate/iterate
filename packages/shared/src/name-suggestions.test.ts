import { describe, expect, it } from "vitest";
import { suggestOrganizationNameFromEmail } from "./name-suggestions.ts";

describe("suggestOrganizationNameFromEmail", () => {
  it("uses the company domain's first label", () => {
    expect(suggestOrganizationNameFromEmail("jonas@nustom.com")).toBe("Nustom");
    expect(suggestOrganizationNameFromEmail("hi@my-startup.co.uk")).toBe("My Startup");
  });

  it("falls back to the local part for generic email providers", () => {
    expect(suggestOrganizationNameFromEmail("jane.doe@gmail.com")).toBe("Jane Doe");
    expect(suggestOrganizationNameFromEmail("jane.doe+work@outlook.com")).toBe("Jane Doe");
    expect(suggestOrganizationNameFromEmail("bob_smith@icloud.com")).toBe("Bob Smith");
  });

  it("normalizes case and whitespace", () => {
    expect(suggestOrganizationNameFromEmail("  JONAS@NUSTOM.COM  ")).toBe("Nustom");
  });

  it("returns an empty string for junk input", () => {
    expect(suggestOrganizationNameFromEmail("")).toBe("");
    expect(suggestOrganizationNameFromEmail("not-an-email")).toBe("");
    expect(suggestOrganizationNameFromEmail("@nustom.com")).toBe("");
  });
});
