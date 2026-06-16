import { expect, test } from "vitest";
import { resolveDevAuthClientSyncTarget } from "./dev-oauth-client-bootstrap.ts";

test("uses personal dev tunnel hostnames as auth client sync targets", () => {
  expect(
    resolveDevAuthClientSyncTarget({
      APP_CONFIG_BASE_URL: "https://os.iterate-dev-misha.com",
    }),
  ).toBe("dev_misha");
});

test("uses local dev underscore stages as auth client sync targets", () => {
  expect(
    resolveDevAuthClientSyncTarget({
      ALCHEMY_STAGE: "dev_misha",
    }),
  ).toBe("dev_misha");
});
