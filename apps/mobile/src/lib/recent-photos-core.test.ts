import { expect, test } from "vitest";
import { photoLibraryAccessFrom } from "./recent-photos-core.ts";

test("granted access shows the roll, including iOS limited selections", () => {
  expect(photoLibraryAccessFrom({ granted: true, canAskAgain: true })).toBe("granted");
  // Limited access still reports granted — the user picked the subset they
  // want us to see, and the strip shows exactly that.
  expect(photoLibraryAccessFrom({ granted: true, canAskAgain: false })).toBe("granted");
});

test("a phone that can still be asked gets the Allow tile, never an unprompted dialog", () => {
  expect(photoLibraryAccessFrom({ granted: false, canAskAgain: true })).toBe("ask");
});

test("a phone that already said no loses the strip instead of being nagged", () => {
  // iOS will not re-show the dialog, so an Allow tile would be a dead
  // control. The + button still opens the picker.
  expect(photoLibraryAccessFrom({ granted: false, canAskAgain: false })).toBe("unavailable");
});
