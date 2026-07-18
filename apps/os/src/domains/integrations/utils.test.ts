import { describe, expect, test } from "vitest";
import {
  integrationConnectionsFromProjectStreams,
  integrationCoordinatesFromStreamPath,
} from "./utils.ts";

describe("integrationCoordinatesFromStreamPath", () => {
  test.each(["/", "/integrations", "/integrations/slack", "/integrations/slack/main/extra"])(
    "ignores non-connection path %s",
    (path) => expect(integrationCoordinatesFromStreamPath(path)).toBeNull(),
  );

  test("parses a complete connection path", () => {
    expect(integrationCoordinatesFromStreamPath("/integrations/github/main")).toEqual({
      connection: "main",
      slug: "github",
    });
  });
});

test("integrationConnectionsFromProjectStreams derives only connection streams", () => {
  expect(
    integrationConnectionsFromProjectStreams([
      { path: "/" },
      { path: "/repos/config" },
      { path: "/integrations/slack/acme" },
      { path: "/integrations/ocado/family" },
    ]),
  ).toEqual([
    { connection: "acme", integration: "slack", path: "/integrations/slack/acme" },
    { connection: "family", integration: "ocado", path: "/integrations/ocado/family" },
  ]);
});
