import { expect, test } from "vitest";
import { isManagementHost } from "./management-host.ts";

test("treats the configured base URL hostname as a management host", () => {
  expect(
    isManagementHost({
      baseUrl: "https://ingress-proxy.iterate-preview-2.com",
      host: "ingress-proxy.iterate-preview-2.com",
    }),
  ).toBe(true);
});

test("keeps project ingress hostnames on the proxy path", () => {
  expect(
    isManagementHost({
      baseUrl: "https://ingress-proxy.iterate-preview-2.com",
      host: "project.ingress.iterate-preview-2.com",
    }),
  ).toBe(false);
});
