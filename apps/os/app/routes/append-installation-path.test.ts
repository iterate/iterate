import { expect, test } from "vitest";
import { appendInstallationPath } from "./append-installation-path.ts";

test("should append the installation path to the redirect path", () => {
  expect(appendInstallationPath("/org_1/est_2", "/estate/path")).toBe("/org_1/est_2/estate/path");
  expect(appendInstallationPath("/org_1/est_2", "/estate/path?param=value")).toBe(
    "/org_1/est_2/estate/path?param=value",
  );
  expect(appendInstallationPath("/org_1/est_2", "estate/path?param=value")).toBe(
    "/org_1/est_2/estate/path?param=value",
  );
  expect(appendInstallationPath("/org_1/est_2?a=b", "estate/path?param=value")).toBe(
    "/org_1/est_2/estate/path?a=b&param=value",
  );

  expect(appendInstallationPath("/org_1/est_2", "//evil.com")).toBe("/org_1/est_2");
  expect(appendInstallationPath("/org_1/est_2", "http://estate.dummy/estate/path")).toBe(
    "/org_1/est_2",
  );
  expect(
    appendInstallationPath("/org_1/est_2", "http://estate.dummy/estate/path?param=value"),
  ).toBe("/org_1/est_2");
  expect(appendInstallationPath("/org_1/est_2", "http://estate.dummy//evil.com")).toBe(
    "/org_1/est_2",
  );
});
