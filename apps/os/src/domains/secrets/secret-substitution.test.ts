import { describe, expect, it } from "vitest";
import { requestReferencesSecret, substituteSecretPlaceholders } from "./secret-substitution.ts";

describe("secret-substitution", () => {
  it("substitutes the placeholder in url, headers, and body", () => {
    const substituted = substituteSecretPlaceholders(
      {
        url: "https://api.example.com/?key={{secret}}",
        method: "POST",
        headers: { authorization: "Bearer {{secret}}", accept: "application/json" },
        body: JSON.stringify({ token: "{{secret}}" }),
      },
      "MATERIAL",
    );
    expect(substituted).toEqual({
      url: "https://api.example.com/?key=MATERIAL",
      method: "POST",
      headers: { authorization: "Bearer MATERIAL", accept: "application/json" },
      body: JSON.stringify({ token: "MATERIAL" }),
    });
  });

  it("detects whether a request references the secret at all", () => {
    expect(requestReferencesSecret({ url: "https://example.com" })).toBe(false);
    expect(
      requestReferencesSecret({
        url: "https://example.com",
        headers: { authorization: "Bearer {{secret}}" },
      }),
    ).toBe(true);
  });
});
