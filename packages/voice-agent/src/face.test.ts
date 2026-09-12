import { describe, expect, it, vi } from "vitest";

const changes: {
  viseme: number;
  confidence: number;
  playoutSamples: number;
}[][] = [];

vi.mock("./viseme.ts", () => ({
  createVisemeTracker: () => ({
    reset: () => {},
    push: () => changes.shift() ?? [],
    end: () => undefined,
  }),
}));

import { createFace } from "./face.ts";

describe("createFace", () => {
  it("gives distinct reduced face values distinct revisions in one clock tick", () => {
    changes.push(
      [{ viseme: 1, confidence: 180, playoutSamples: 512 }],
      [{ viseme: 2, confidence: 181, playoutSamples: 768 }],
    );
    const face = createFace();
    face.answerStarted();
    face.audio(new Uint8Array(), 100);
    expect(face.read()).toMatchObject({ answer: 1, viseme: 1, at: 100 });
    face.audio(new Uint8Array(), 100);
    expect(face.read()).toMatchObject({ answer: 1, viseme: 2, at: 101 });
  });
});
