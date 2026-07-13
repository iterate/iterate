import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeAuthorizationResponseIssuerOptional } from "./oauth-metadata.ts";

describe("OAuth metadata compatibility", () => {
  it("does not advertise the authorization-response issuer as required", async () => {
    const response = Response.json(
      {
        issuer: "https://auth.iterate.com/api/auth",
        authorization_response_iss_parameter_supported: true,
        code_challenge_methods_supported: ["S256"],
      },
      {
        headers: {
          "cache-control": "public, max-age=3600",
        },
      },
    );

    const compatibleResponse = await makeAuthorizationResponseIssuerOptional(response);
    const metadata = (await compatibleResponse.json()) as Record<string, unknown>;

    assert.equal("authorization_response_iss_parameter_supported" in metadata, false);
    assert.equal(metadata.issuer, "https://auth.iterate.com/api/auth");
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    assert.equal(compatibleResponse.headers.get("cache-control"), "public, max-age=3600");
  });
});
