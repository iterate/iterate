import { describe, expect, it } from "vitest";

import { supportedBoardProofTargets } from "../../../kit/src/firmware/catalog.ts";
import { selectBoards } from "./boards.ts";

describe("selectBoards", () => {
  it("uses the shared client-path resolver for aliases and paths", () => {
    expect(selectBoards("havpe").map((board) => board.name)).toEqual([
      "home-assistant-voice-preview-edition",
    ]);
    expect(selectBoards("/clients/satellite1").map((board) => board.name)).toEqual(["satellite1"]);
  });

  it("includes every supported board for an omitted or empty selector", () => {
    expect(selectBoards()).toEqual(supportedBoardProofTargets);
    expect(selectBoards("")).toEqual(supportedBoardProofTargets);
  });
});
