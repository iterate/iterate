import { describe, test, expect } from "vitest";
import { isEmailAllowed } from "./signup-allowlist.ts";

describe("isEmailAllowed", () => {
  describe("domain wildcard patterns (*@domain.com)", () => {
    test("allows emails matching wildcard domain", () => {
      expect(isEmailAllowed("user@nustom.com", "*@nustom.com")).toBe(true);
      expect(isEmailAllowed("another.user@nustom.com", "*@nustom.com")).toBe(true);
    });

    test("rejects emails not matching wildcard domain", () => {
      expect(isEmailAllowed("user@other.com", "*@nustom.com")).toBe(false);
      expect(isEmailAllowed("user@nustom.org", "*@nustom.com")).toBe(false);
    });

    test("handles multiple wildcard domains", () => {
      const allowlist = "*@nustom.com, *@iterate.com";
      expect(isEmailAllowed("user@nustom.com", allowlist)).toBe(true);
      expect(isEmailAllowed("user@iterate.com", allowlist)).toBe(true);
      expect(isEmailAllowed("user@other.com", allowlist)).toBe(false);
    });
  });

  describe("explicit email patterns", () => {
    test("allows exact email matches", () => {
      expect(isEmailAllowed("specific@example.com", "specific@example.com")).toBe(true);
    });

    test("rejects non-matching emails", () => {
      expect(isEmailAllowed("other@example.com", "specific@example.com")).toBe(false);
    });

    test("handles mixed explicit and wildcard patterns", () => {
      const allowlist = "*@nustom.com, vip@external.com";
      expect(isEmailAllowed("user@nustom.com", allowlist)).toBe(true);
      expect(isEmailAllowed("vip@external.com", allowlist)).toBe(true);
      expect(isEmailAllowed("other@external.com", allowlist)).toBe(false);
    });
  });

  describe("case insensitivity", () => {
    test("handles uppercase emails", () => {
      expect(isEmailAllowed("USER@NUSTOM.COM", "*@nustom.com")).toBe(true);
      expect(isEmailAllowed("User@Nustom.Com", "*@nustom.com")).toBe(true);
    });

    test("handles uppercase patterns", () => {
      expect(isEmailAllowed("user@nustom.com", "*@NUSTOM.COM")).toBe(true);
    });

    test("handles mixed case explicit emails", () => {
      expect(isEmailAllowed("VIP@Example.Com", "vip@example.com")).toBe(true);
    });
  });

  describe("whitespace handling", () => {
    test("trims spaces around patterns", () => {
      const allowlist = "  *@nustom.com  ,  *@iterate.com  ";
      expect(isEmailAllowed("user@nustom.com", allowlist)).toBe(true);
      expect(isEmailAllowed("user@iterate.com", allowlist)).toBe(true);
    });

    test("trims spaces around email input", () => {
      expect(isEmailAllowed("  user@nustom.com  ", "*@nustom.com")).toBe(true);
    });

    test("ignores empty patterns from extra commas", () => {
      expect(isEmailAllowed("user@nustom.com", "*@nustom.com,,")).toBe(true);
    });
  });

  describe("edge cases", () => {
    test("rejects all emails when allowlist is empty", () => {
      expect(isEmailAllowed("user@nustom.com", "")).toBe(false);
      expect(isEmailAllowed("user@nustom.com", "   ")).toBe(false);
    });

    test("does not match partial domains", () => {
      expect(isEmailAllowed("user@subnustom.com", "*@nustom.com")).toBe(false);
      expect(isEmailAllowed("user@nustom.com.evil.com", "*@nustom.com")).toBe(false);
    });
  });
});

