import { describe, expect, test } from "vitest";
import {
  getDefaultOrganizationNameFromEmail,
  parseRecipientLocal,
  parseSender,
  parseSenderEmail,
} from "./email-routing.ts";
import { isSignupAllowed } from "./signup-allowlist.ts";

describe("email routing helpers", () => {
  test("organization name defaults to email domain for work emails", () => {
    expect(getDefaultOrganizationNameFromEmail("person@nustom.com")).toBe("nustom");
  });

  test("organization name defaults to username for free email providers", () => {
    expect(getDefaultOrganizationNameFromEmail("testuser+foo@gmail.com")).toBe("testuser");
  });

  test("parses sender details from display name format", () => {
    expect(parseSender("Jane Doe <jane@example.com>")).toEqual({
      name: "Jane Doe",
      email: "jane@example.com",
    });
    expect(parseSenderEmail("Jane Doe <jane@example.com>")).toBe("jane@example.com");
  });

  test("parses recipient local part", () => {
    expect(parseRecipientLocal("dev-mmkal+project@mail.iterate.com")).toBe("dev-mmkal+project");
  });

  test("matches signup allowlist patterns", () => {
    expect(isSignupAllowed("person@example.com", "*@example.com,admin@iterate.com")).toBe(true);
    expect(isSignupAllowed("person@other.com", "*@example.com,admin@iterate.com")).toBe(false);
  });
});
