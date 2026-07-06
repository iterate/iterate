// Unit tests for the secret substitution grammar and compute helpers (design
// §2.1). Pure functions — no workerd, no DO. The chaining that stitches these
// across several secrets lives in SecretDurableObject and is exercised by the
// integration proofs (S5).

import { describe, expect, test } from "vitest";
import {
  computeHmacHex,
  secretReferencePathsFromHeaders,
  secretReferencesFromHeaders,
  SecretSubstitutionError,
  selectSecretField,
  substituteSecretHeaders,
  timingSafeStringEqual,
} from "./utils.ts";

describe("selectSecretField", () => {
  test("no field returns whole material iff it is a string", () => {
    expect(selectSecretField("xoxb-token")).toBe("xoxb-token");
    expect(() => selectSecretField({ accessToken: "a" })).toThrow(SecretSubstitutionError);
  });

  test("dotted field walks structured material to a string", () => {
    const material = { tokens: { access: "at-1", refresh: "rt-1" } };
    expect(selectSecretField(material, "tokens.access")).toBe("at-1");
  });

  test("missing field or non-string leaf throws", () => {
    expect(() => selectSecretField({ a: 1 }, "a")).toThrow(SecretSubstitutionError);
    expect(() => selectSecretField({ a: "x" }, "b")).toThrow(SecretSubstitutionError);
  });
});

describe("secret reference parsing", () => {
  test("parses path-only and path+field placeholders across headers", () => {
    const headers = new Headers({
      authorization: 'Basic getSecret("/secrets/integrations/petshop-home", "basicAuth")',
      "x-token": 'Bearer getSecret("/secrets/integrations/petshop-home/jonas", "tokens.access")',
    });
    expect(secretReferencesFromHeaders(headers)).toEqual([
      { field: "basicAuth", path: "/secrets/integrations/petshop-home" },
      { field: "tokens.access", path: "/secrets/integrations/petshop-home/jonas" },
    ]);
    expect(secretReferencePathsFromHeaders(headers)).toEqual([
      "/secrets/integrations/petshop-home",
      "/secrets/integrations/petshop-home/jonas",
    ]);
  });

  test("whole-material placeholder still parses (pre-field shape)", () => {
    const headers = new Headers({ authorization: 'Bearer getSecret("/secrets/openai")' });
    expect(secretReferencesFromHeaders(headers)).toEqual([{ path: "/secrets/openai" }]);
  });
});

describe("substituteSecretHeaders", () => {
  test("replaces each placeholder with the resolved value", () => {
    const request = new Request("https://api.resend.com/emails", {
      headers: { authorization: 'Bearer getSecret("/secrets/resend", "apiKey")' },
    });
    const substituted = substituteSecretHeaders(request, ({ path, field }) => {
      expect(path).toBe("/secrets/resend");
      expect(field).toBe("apiKey");
      return "re_live_123";
    });
    expect(substituted.headers.get("authorization")).toBe("Bearer re_live_123");
  });
});

describe("compute helpers", () => {
  test("computeHmacHex matches a known GitHub-style sha256 vector", async () => {
    // echo -n "hello world" | openssl dgst -sha256 -hmac "It's a Secret to Everybody"
    const digest = await computeHmacHex({
      algo: "sha256",
      key: "It's a Secret to Everybody",
      payload: "hello world",
    });
    expect(digest).toBe("cf0f2a031631d0d363407e4c4b717ff68cdedb238154f12cf2beeef298359fbd");
  });

  test("timingSafeStringEqual", () => {
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
    expect(timingSafeStringEqual("abc", "abd")).toBe(false);
    expect(timingSafeStringEqual("abc", "abcd")).toBe(false);
  });
});
