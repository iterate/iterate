// The itx secrets allowlist: writes and redacted summaries dispatch; the
// material-returning methods refuse with a self-describing error. This is
// the unit-level proof behind the "secret material is never readable through
// itx" property — the e2e (itx-egress.e2e.test.ts) proves the happy path
// against a real deployment.

import { describe, expect, test } from "vitest";
import { ITX_SECRETS_METHODS, resolveItxSecretsMethod } from "./secrets-capability-call.ts";

describe("resolveItxSecretsMethod", () => {
  test("dispatches exactly the write-and-summary surface", () => {
    expect([...ITX_SECRETS_METHODS]).toEqual([
      "setSecret",
      "listSecrets",
      "deleteSecret",
      "getSecretSummaryByKey",
    ]);
    for (const method of ITX_SECRETS_METHODS) {
      expect(resolveItxSecretsMethod([method])).toBe(method);
    }
  });

  test("material-returning methods are refused with the self-describing error", () => {
    for (const method of ["getSecret", "getSecretOrNull", "getSecretSummary", "deleteSecretById"]) {
      expect(() => resolveItxSecretsMethod([method])).toThrow(
        /secret material is never readable through itx — placeholders are substituted on egress/,
      );
      expect(() => resolveItxSecretsMethod([method])).toThrow(
        /setSecret\/listSecrets\/deleteSecret\/getSecretSummaryByKey/,
      );
    }
  });

  test("deeper paths, empty paths, and protocol names refuse too", () => {
    expect(() => resolveItxSecretsMethod(["setSecret", "deeper"])).toThrow(
      /got "setSecret\.deeper"/,
    );
    expect(() => resolveItxSecretsMethod([])).toThrow(/itx\.secrets exposes/);
    // describeItx is a reserved protocol name, not an allowlisted method —
    // itx.secrets refuses it like any other non-allowlisted path.
    expect(() => resolveItxSecretsMethod(["describeItx"])).toThrow(/itx\.secrets exposes/);
  });
});
