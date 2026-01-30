import { expect, test, describe } from "vitest";
import { getSecretHint } from "./secret-hint.ts";

describe("getSecretHint", () => {
  describe("key name detection", () => {
    test("detects API_KEY in key name", () => {
      const hint = getSecretHint("MY_API_KEY", "somevalue");
      expect(hint.looksLikeSecret).toBe(true);
      expect(hint.reason).toBe("key-name");
    });

    test("detects SECRET in key name", () => {
      const hint = getSecretHint("DATABASE_SECRET", "somevalue");
      expect(hint.looksLikeSecret).toBe(true);
      expect(hint.reason).toBe("key-name");
    });

    test("detects ACCESS_TOKEN in key name", () => {
      const hint = getSecretHint("GITHUB_ACCESS_TOKEN", "somevalue");
      expect(hint.looksLikeSecret).toBe(true);
      expect(hint.reason).toBe("key-name");
    });

    test("ignores normal key names", () => {
      const hint = getSecretHint("DATABASE_URL", "postgres://localhost/db");
      expect(hint.looksLikeSecret).toBe(false);
    });
  });

  describe("value pattern detection", () => {
    test("detects OpenAI API key", () => {
      const hint = getSecretHint("SOME_KEY", "sk-abcdefghijklmnopqrstuvwxyz123456");
      expect(hint.looksLikeSecret).toBe(true);
      expect(hint.reason).toBe("value-pattern");
    });

    test("detects Anthropic API key", () => {
      const hint = getSecretHint("SOME_KEY", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
      expect(hint.looksLikeSecret).toBe(true);
      expect(hint.reason).toBe("value-pattern");
    });

    test("detects Stripe API key", () => {
      // Build in parts to avoid GitHub secret scanning
      const hint = getSecretHint("SOME_KEY", "sk_" + "live_abcdefghijklmnopqrstuvwx");
      expect(hint.looksLikeSecret).toBe(true);
      expect(hint.reason).toBe("value-pattern");
    });

    test("detects AWS access key", () => {
      const hint = getSecretHint("SOME_KEY", "AKIAIOSFODNN7EXAMPLE");
      expect(hint.looksLikeSecret).toBe(true);
      expect(hint.reason).toBe("value-pattern");
    });

    test("detects GitHub token", () => {
      const hint = getSecretHint("SOME_KEY", "ghp_abcdefghijklmnopqrstuvwxyz1234567890");
      expect(hint.looksLikeSecret).toBe(true);
      expect(hint.reason).toBe("value-pattern");
    });

    test("detects private key header", () => {
      const hint = getSecretHint("SOME_KEY", "-----BEGIN RSA PRIVATE KEY-----\nMIIE...");
      expect(hint.looksLikeSecret).toBe(true);
      expect(hint.reason).toBe("value-pattern");
    });
  });

  describe("entropy detection", () => {
    test("detects high-entropy string", () => {
      // Random-looking string with mixed case, numbers, special chars
      const hint = getSecretHint("SOME_KEY", "aB3$kL9@mN2#pQ5&rS8*tU1!");
      expect(hint.looksLikeSecret).toBe(true);
      expect(hint.reason).toBe("high-entropy");
    });

    test("ignores low-entropy string", () => {
      const hint = getSecretHint("SOME_KEY", "hello world");
      expect(hint.looksLikeSecret).toBe(false);
    });

    test("ignores short high-entropy string", () => {
      // Short strings shouldn't trigger even if high entropy
      const hint = getSecretHint("SOME_KEY", "aB3$");
      expect(hint.looksLikeSecret).toBe(false);
    });
  });

  describe("non-secrets", () => {
    test("ignores normal URLs", () => {
      const hint = getSecretHint("DATABASE_URL", "postgres://localhost:5432/mydb");
      expect(hint.looksLikeSecret).toBe(false);
    });

    test("ignores normal text values", () => {
      const hint = getSecretHint("APP_NAME", "My Application");
      expect(hint.looksLikeSecret).toBe(false);
    });

    test("ignores boolean-like values", () => {
      const hint = getSecretHint("DEBUG", "true");
      expect(hint.looksLikeSecret).toBe(false);
    });

    test("ignores numeric values", () => {
      const hint = getSecretHint("PORT", "3000");
      expect(hint.looksLikeSecret).toBe(false);
    });
  });
});
