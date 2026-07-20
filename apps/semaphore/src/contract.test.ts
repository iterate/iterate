import { expect, it } from "vitest";
import { AcquireResourceInput } from "./contract.ts";

it("keeps older preview clients inside the original nine slots", () => {
  expect(
    AcquireResourceInput.parse({
      type: "environment-config-lease",
      leaseMs: 60_000,
    }),
  ).toMatchObject({
    allowedSlugs: [
      "preview-1",
      "preview-2",
      "preview-3",
      "preview-4",
      "preview-5",
      "preview-6",
      "preview-7",
      "preview-8",
      "preview-9",
    ],
  });
});

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
