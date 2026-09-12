import { describe, expect, it } from "vitest";

import { selectBoards } from "./boards.ts";

describe("selectBoards", () => {
  it("uses the shared client-path resolver for aliases and paths", () => {
    expect(selectBoards("havpe").map((board) => board.name)).toEqual([
      "home-assistant-voice-preview-edition",
    ]);
    expect(selectBoards("/clients/satellite1").map((board) => board.name)).toEqual(["satellite1"]);
  });

  it("includes every supported board for an omitted or empty selector", () => {
    expect(selectBoards().map((board) => board.name)).toContain("satellite1");
    expect(selectBoards("").map((board) => board.name)).toContain("satellite1");
  });
});
