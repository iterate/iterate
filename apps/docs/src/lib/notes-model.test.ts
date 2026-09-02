import { describe, expect, test } from "vitest";
import {
  DEFAULT_NOTE,
  ensureTodayHeading,
  lastLogDate,
  logDateStamp,
  noteChangesFrom,
  noteFileName,
  noteLabel,
  notesCommitMessage,
} from "./notes-model.ts";

describe("notes model", () => {
  test("the date stamp is the local calendar day, zero-padded", () => {
    expect(logDateStamp(new Date(2026, 8, 2, 9, 5))).toBe("2026-09-02");
  });

  test("a missing log starts with today's heading and the line to write on", () => {
    expect(ensureTodayHeading(null, "2026-09-02")).toBe("## 2026-09-02\n\n");
    expect(ensureTodayHeading("", "2026-09-02")).toBe("## 2026-09-02\n\n");
  });

  test("a log already under today's heading is left byte-for-byte alone", () => {
    const content = "## 2026-09-01\n\nyesterday\n\n## 2026-09-02\n\ntoday so far\n";
    expect(ensureTodayHeading(content, "2026-09-02")).toBe(content);
  });

  test("a new day appends its heading after one blank line, folding trailing blank lines", () => {
    expect(ensureTodayHeading("## 2026-09-01\n\nlate note\n\n\n", "2026-09-02")).toBe(
      "## 2026-09-01\n\nlate note\n\n## 2026-09-02\n\n",
    );
    expect(ensureTodayHeading("notes without headings", "2026-09-02")).toBe(
      "notes without headings\n\n## 2026-09-02\n\n",
    );
  });

  test("the last day heading is the most recent one in file order", () => {
    expect(lastLogDate("## 2026-09-01\n\na\n\n## 2026-09-02\n\nb\n")).toBe("2026-09-02");
    expect(lastLogDate("just text\n")).toBeNull();
    expect(notesCommitMessage("2026-09-02")).toBe("Notes: 2026-09-02");
  });

  test("the dirty set keeps only notes under the repo's own mount", () => {
    const status = {
      mounts: [
        {
          path: "/repos/config",
          changes: [
            { change: "modified", path: "/repos/config/notes/log.md" },
            { change: "added", path: "/repos/config/notes/ideas.md" },
            { change: "modified", path: "/repos/config/tasks/one.md" },
          ],
        },
        { path: "/repos/other", changes: [{ change: "added", path: "/repos/other/notes/x.md" }] },
      ],
      unmounted: [],
    };
    expect([...noteChangesFrom(status, "/repos/config")].sort()).toEqual([
      "notes/ideas.md",
      "notes/log.md",
    ]);
  });

  test("new notes get slug file names under notes/, and labels come from the stem", () => {
    expect(noteFileName("Ideas for Q4!")).toBe("notes/ideas-for-q4.md");
    expect(noteFileName("   ")).toBe("notes/note.md");
    expect(noteLabel(DEFAULT_NOTE)).toBe("Log");
    expect(noteLabel("notes/ideas-for-q4.md")).toBe("ideas-for-q4");
  });
});
