import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ITERATE_BROWSER_EXTENSION_ORIGIN, resolveAllowedBrowserOrigin } from "./browser-origin.ts";

const productionPolicy = {
  authAppOrigin: "https://auth.iterate.com",
  publicUrl: undefined,
  fixedTestOtpEnabled: false,
};

describe("resolveAllowedBrowserOrigin", () => {
  it("allows the production Iterate browser extension origin without turning it into null", () => {
    assert.equal(
      resolveAllowedBrowserOrigin(ITERATE_BROWSER_EXTENSION_ORIGIN, productionPolicy),
      ITERATE_BROWSER_EXTENSION_ORIGIN,
    );
  });

  it("rejects a different Chrome extension", () => {
    assert.equal(
      resolveAllowedBrowserOrigin(
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        productionPolicy,
      ),
      null,
    );
  });

  it("keeps the existing deployment and loopback policy", () => {
    assert.equal(
      resolveAllowedBrowserOrigin("https://auth.iterate.com", productionPolicy),
      "https://auth.iterate.com",
    );
    assert.equal(
      resolveAllowedBrowserOrigin("http://localhost:6274", productionPolicy),
      "http://localhost:6274",
    );
    assert.equal(resolveAllowedBrowserOrigin("http://localhost:8123", productionPolicy), null);
    assert.equal(
      resolveAllowedBrowserOrigin("http://localhost:8123", {
        ...productionPolicy,
        fixedTestOtpEnabled: true,
      }),
      "http://localhost:8123",
    );
  });
});
