import { describe, expect, it } from "vitest";
import { assertDopplerSecretAbsent } from "./deploy-helpers.ts";

const project = "os";
const config = "preview_4";
const secretName = "APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN";

describe("assertDopplerSecretAbsent", () => {
  it("accepts a resolved config without the forbidden source", () => {
    expect(() =>
      assertDopplerSecretAbsent({ project, config, secretName, secrets: {} }),
    ).not.toThrow();
  });

  it("fails closed without exposing the forbidden value", () => {
    const forbiddenValue = "must-not-appear-in-errors";

    expect(() =>
      assertDopplerSecretAbsent({
        project,
        config,
        secretName,
        secrets: { [secretName]: forbiddenValue },
      }),
    ).toThrow(`${project}/${config}/${secretName}`);

    try {
      assertDopplerSecretAbsent({
        project,
        config,
        secretName,
        secrets: { [secretName]: forbiddenValue },
      });
    } catch (error) {
      expect(String(error)).not.toContain(forbiddenValue);
    }
  });
});
