import { expect, test } from "vitest";
import { planCleanup } from "./cleanup-mobile-pr-preview.ts";

test("a closed PR's channel and QR assets are targeted by branch and number", () => {
  expect(planCleanup({ headRef: "fix/some-mobile-thing", prNumber: 2412 })).toMatchObject({
    channel: "fix-some-mobile-thing",
    qrAssetPrefix: "mobile-pr-2412-",
  });
});

test("the default channel can never be deleted, even by a branch named preview", () => {
  expect(planCleanup({ headRef: "preview", prNumber: 99 })).toMatchObject({
    channel: undefined,
    qrAssetPrefix: "mobile-pr-99-",
  });
  expect(planCleanup({ headRef: "PREVIEW", prNumber: 99 })).toMatchObject({ channel: undefined });
});

test("a payload with no head ref still cleans up QR assets", () => {
  expect(planCleanup({ headRef: undefined, prNumber: 7 })).toMatchObject({
    channel: undefined,
    qrAssetPrefix: "mobile-pr-7-",
  });
});
