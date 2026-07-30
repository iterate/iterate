import { expect, it } from "vitest";
import { AcquireResourceInput } from "./contract.ts";

it("rejects duplicate allowed slugs", () => {
  expect(
    AcquireResourceInput.safeParse({
      type: "environment-config-lease",
      leaseMs: 60_000,
      allowedSlugs: ["preview-2", "preview-2"],
    }),
  ).toMatchObject({ success: false });
});

it("preserves an explicit preview allow-list", () => {
  expect(
    AcquireResourceInput.parse({
      type: "environment-config-lease",
      leaseMs: 60_000,
      allowedSlugs: ["preview-17"],
    }),
  ).toMatchObject({ allowedSlugs: ["preview-17"] });
});

it("leaves unrelated resource types unrestricted when allowedSlugs is omitted", () => {
  expect(
    AcquireResourceInput.parse({
      type: "browser-lease",
      leaseMs: 60_000,
    }),
  ).not.toHaveProperty("allowedSlugs");
});
