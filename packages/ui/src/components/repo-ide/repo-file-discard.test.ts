import { expect, test } from "vitest";
import { discardRepoFile, NEW_FILE_DISCARD_CONFIRMATION } from "./repo-file-discard.ts";

test("discarding a selected new file confirms, closes it, and then removes it", () => {
  const events: string[] = [];

  discardRepoFile({
    path: "draft.md",
    headHasPath: false,
    selected: true,
    confirmDiscard: (message) => {
      events.push(`confirm:${message}`);
      return true;
    },
    discardWorking: (path) => events.push(`discard:${path}`),
    removeWorkingFile: (path) => events.push(`remove:${path}`),
    closeSelectedFile: () => events.push("close"),
  });

  expect(events).toEqual([`confirm:${NEW_FILE_DISCARD_CONFIRMATION}`, "close", "remove:draft.md"]);
});

test("cancelling new-file discard preserves the file and selection", () => {
  const events: string[] = [];

  discardRepoFile({
    path: "draft.md",
    headHasPath: false,
    selected: true,
    confirmDiscard: (message) => {
      events.push(`confirm:${message}`);
      return false;
    },
    discardWorking: (path) => events.push(`discard:${path}`),
    removeWorkingFile: (path) => events.push(`remove:${path}`),
    closeSelectedFile: () => events.push("close"),
  });

  expect(events).toEqual([`confirm:${NEW_FILE_DISCARD_CONFIRMATION}`]);
});

test("discarding a tracked file reverts it without confirmation", () => {
  const events: string[] = [];

  discardRepoFile({
    path: "README.md",
    headHasPath: true,
    selected: true,
    confirmDiscard: (message) => {
      events.push(`confirm:${message}`);
      return true;
    },
    discardWorking: (path) => events.push(`discard:${path}`),
    removeWorkingFile: (path) => events.push(`remove:${path}`),
    closeSelectedFile: () => events.push("close"),
  });

  expect(events).toEqual(["discard:README.md"]);
});
