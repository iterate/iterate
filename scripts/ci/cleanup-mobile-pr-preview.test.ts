import { expect, test } from "vitest";
import { closedSectionContents, planCleanup } from "./cleanup-mobile-pr-preview.ts";
import { isMainFlavoredSection } from "./mobile-preview.ts";

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

test("a merged PR's section promises main's QRs; an unmerged close just says gone", () => {
  const merged = closedSectionContents({ merged: true });
  expect(merged).toContain("Main's QR codes land here");
  expect(merged).not.toContain("iterate://");
  const closed = closedSectionContents({ merged: false });
  expect(closed).toContain("Closed without merging");
});

test("the close-event rewrite never clobbers a section already upgraded to main's", () => {
  // The closed event and the merge push race; whoever wrote the main variant
  // won and must stay.
  expect(isMainFlavoredSection("## 📱 Mobile preview — main\n…")).toBe(true);
  expect(isMainFlavoredSection("## 📱 Mobile preview\nChannel `x`")).toBe(false);
});
