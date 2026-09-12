import { describe, expect, it } from "vitest";
import { firmwareCatalog, supportedBoardProofTargets } from "./catalog.ts";

describe("firmwareCatalog", () => {
  it("is the five-board source for installer and proof identities", () => {
    expect(supportedBoardProofTargets.map((board) => board.name).sort()).toEqual([
      "home-assistant-voice-preview-edition",
      "m5stick-s3",
      "satellite1",
      "stackchan",
      "waveshare",
    ]);
  });

  it("requests provider visemes only for Waveshare", () => {
    expect(firmwareCatalog.filter((board) => board.remoteVisemes).map((board) => board.id)).toEqual(
      ["waveshare"],
    );
  });
});
