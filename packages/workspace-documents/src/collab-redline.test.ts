import { collab, receiveUpdates, sendableUpdates } from "@codemirror/collab";
import { EditorState, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { foldAttribution } from "./collab-attribution.ts";
import { authorLabel } from "./collab-author.ts";
import { CollabConnection } from "./collab-client.ts";
import { hasCollabDelivery } from "./collab-redline.ts";
import type { WorkspaceDocumentTransport } from "./types.ts";

describe("authorLabel", () => {
  it("agents read as agent", () => {
    expect(authorLabel("external")).toBe("agent");
  });
  it("named ids surface the full display slug — the random suffix never bleeds in", () => {
    expect(authorLabel("u-usr-jonas-xlo98p")).toBe("usr jonas");
    expect(authorLabel("u-jonas-templestein-a1b2c3")).toBe("jonas templestein");
  });
  it("unrecognized ids are someone", () => {
    expect(authorLabel("web-abcdef")).toBe("someone");
  });
});

describe("redline delivery detection", () => {
  it("advances attribution when the server acknowledges an optimistic edit", () => {
    const initial = EditorState.create({
      doc: "a",
      extensions: collab({ clientID: "mine", startVersion: 0 }),
    });
    const optimistic = initial.update({ changes: { from: 1, insert: "b" } }).state;
    const first = sendableUpdates(optimistic)[0]!;
    const acknowledgement = receiveUpdates(optimistic, [
      { changes: first.changes, clientID: "mine" },
    ]);
    const connection = new CollabConnection(
      {} as WorkspaceDocumentTransport,
      "/reviews/plan.md",
      "mine",
    );
    connection.stageDeliveredOps([{ changes: first.changes.toJSON(), clientId: "mine" }]);

    // The visible document already contains our optimistic edit, so receiving
    // its canonical echo changes collab bookkeeping but not the document.
    expect(acknowledgement.docChanged).toBe(false);
    expect(hasCollabDelivery(connection)).toBe(true);

    const confirmed = foldAttribution(
      { deleted: [], doc: Text.of(["a"]), inserted: [] },
      { changes: first.changes.toJSON(), clientId: "mine" },
    );
    const next = acknowledgement.state.update({ changes: { from: 2, insert: "c" } }).state;
    const nextUpdate = sendableUpdates(next)[0]!;
    expect(() =>
      foldAttribution(confirmed, {
        changes: nextUpdate.changes.toJSON(),
        clientId: "mine",
      }),
    ).not.toThrow();
  });
});
