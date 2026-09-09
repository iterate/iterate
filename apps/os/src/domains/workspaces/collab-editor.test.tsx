/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { collab, receiveUpdates, sendableUpdates } from "@codemirror/collab";
import type { Extension } from "@codemirror/state";
import {
  CollabConnection,
  redlineExtension,
  useCollabEditor,
} from "@iterate-com/workspace-documents/collab";
import type { CollabEditorApi } from "@iterate-com/workspace-documents/editor-api";
import type {
  CollabWaitResult,
  CollabChanges,
  WorkspaceCollabSurface,
  WorkspaceDocumentTransport,
  WorkspaceSurface,
} from "@iterate-com/workspace-documents/types";
import { expect, test, vi } from "vitest";

/** The five collab doors the editor drives, as the only member of a fake workspace. */
type FakeDocumentSession = Pick<
  WorkspaceCollabSurface,
  "changes" | "open" | "present" | "push" | "wait"
>;

/** A transport over one fake session: the editor never touches fs or git here. */
function transportFor(documentSession: FakeDocumentSession): WorkspaceDocumentTransport {
  const workspace = { collab: documentSession } as unknown as WorkspaceSurface;
  return {
    run: async (operation) => await operation(workspace),
    runOnce: async (operation) => await operation(workspace),
  };
}

test("an acknowledgement retries redline loading after version mismatches exhaust retries", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const connection = new CollabConnection({ run: vi.fn(), runOnce: vi.fn() }, "/notes.md");
  const changes = vi.spyOn(connection, "changes").mockResolvedValue({
    baseContent: "a",
    baseVersion: 0,
    headVersion: 1,
    deleted: [],
    inserted: [{ from: 1, to: 2, clientId: "mine" }],
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    parent: host,
    doc: "a",
    extensions: [collab({ clientID: "mine" }), redlineExtension(connection)],
  });
  try {
    view.dispatch({ changes: { from: 1, insert: "b" } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("has not caught up");
    const sent = sendableUpdates(view.state)[0]!;
    connection.stageDeliveredOps([{ changes: sent.changes.toJSON(), clientId: "mine" }]);
    const acknowledgement = receiveUpdates(view.state, [
      { changes: sent.changes, clientID: "mine" },
    ]);
    expect(acknowledgement.docChanged).toBe(false);
    const requestsBeforeAck = changes.mock.calls.length;
    view.dispatch(acknowledgement);
    connection.takeDeliveredOps();
    await vi.advanceTimersByTimeAsync(500);
    expect(changes.mock.calls.length).toBe(requestsBeforeAck + 1);
    expect(host.querySelector<HTMLElement>('[role="status"]')?.hidden).toBe(true);
    expect(host.querySelector(".cm-redline-ins")?.textContent).toBe("b");
  } finally {
    view.destroy();
    host.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

test.for(["loaded", "failed"])("redlines expose their loading and %s state", async (outcome) => {
  const response = Promise.withResolvers<CollabChanges>();
  const connection = new CollabConnection({ run: vi.fn(), runOnce: vi.fn() }, "/notes.md");
  vi.spyOn(connection, "changes").mockReturnValue(response.promise);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    parent: host,
    doc: "Reviewed in Docs.",
    extensions: [collab({ startVersion: 1 }), redlineExtension(connection)],
  });
  try {
    expect(host.querySelector('[data-spinner="true"]')?.textContent).toBe("Loading changes…");
    if (outcome === "loaded") {
      response.resolve({
        baseContent: "",
        baseVersion: 0,
        headVersion: 1,
        deleted: [],
        inserted: [{ from: 0, to: 17, clientId: "reviewer" }],
      });
    } else {
      response.reject(new Error("Attribution unavailable"));
    }
    await response.promise.catch(() => {});
    await Promise.resolve();
    expect(host.querySelector('[data-spinner="true"]')).toBeNull();
    if (outcome === "loaded") {
      expect(host.querySelector(".cm-redline-ins")?.textContent).toBe("Reviewed in Docs.");
      expect(host.querySelector<HTMLElement>('[role="status"]')?.hidden).toBe(true);
    } else {
      expect(host.querySelector('[role="status"]')?.textContent).toBe(
        "Could not load changes: Attribution unavailable",
      );
    }
  } finally {
    view.destroy();
    host.remove();
    vi.restoreAllMocks();
  }
});

test("a recovery snapshot updates the preview and cancels stale debounced text", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const delivery = Promise.withResolvers<CollabWaitResult>();
  const documentSession: FakeDocumentSession = {
    open: async () => ({ content: "# Before", epoch: "first", version: 0 }),
    wait: vi
      .fn()
      .mockReturnValueOnce(delivery.promise)
      .mockImplementation(() => new Promise(() => {})),
    push: async () => ({ status: "history-miss" }),
    present: async () => {},
    changes: async () => ({
      baseContent: "# Before",
      baseVersion: 0,
      headVersion: 0,
      inserted: [],
      deleted: [],
    }),
  };
  const transport = transportFor(documentSession);
  const apiRef: { current: CollabEditorApi | null } = { current: null };
  const onLiveContent = vi.fn();
  const extensions: Extension[] = [];
  function Editor() {
    const { host } = useCollabEditor({
      transport,
      path: "/notes.md",
      extensions,
      redline: false,
      apiRef,
      onLiveContent,
    });
    return <div ref={host} />;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Editor />));
    const view = EditorView.findFromDOM(host.querySelector(".cm-content")!)!;
    await act(async () => view.dispatch({ changes: { from: 8, insert: " typing" } }));
    await act(async () =>
      delivery.resolve({
        status: "snapshot",
        snapshot: { content: "# After", epoch: "second", version: 7, ackedSeq: -1 },
      }),
    );
    expect(apiRef.current?.source()).toBe("# After");
    expect(onLiveContent).toHaveBeenLastCalledWith("/notes.md", "# After");
    await act(async () => vi.advanceTimersByTime(200));
    expect(onLiveContent).toHaveBeenLastCalledWith("/notes.md", "# After");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

test("presentation changes preserve the live session and selection; an ended session refuses edits", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const delivery = Promise.withResolvers<CollabWaitResult>();
  const documentSession: FakeDocumentSession = {
    open: vi.fn(async () => ({ content: "# Shared", epoch: "first", version: 0 })),
    wait: () => delivery.promise,
    push: async () => ({ status: "accepted", version: 1 }),
    present: async () => {},
    changes: async () => ({
      baseContent: "# Shared",
      baseVersion: 0,
      headVersion: 0,
      inserted: [],
      deleted: [],
    }),
  };
  const transport = transportFor(documentSession);
  const apiRef: { current: CollabEditorApi | null } = { current: null };
  const extensions: Extension = [];
  const rich = EditorView.editorAttributes.of({ class: "rich-presentation" });
  const source: Extension = [];
  function Editor({ presentation }: { presentation: Extension }) {
    const { host } = useCollabEditor({
      transport,
      path: "/notes.md",
      extensions,
      presentation,
      redline: false,
      apiRef,
    });
    return <div ref={host} />;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Editor presentation={rich} />));
    const view = EditorView.findFromDOM(host.querySelector(".cm-content")!)!;
    await act(async () =>
      view.dispatch({
        changes: { from: 8, insert: " edit" },
        selection: { anchor: 12 },
        userEvent: "input.type",
      }),
    );
    const selection = view.state.selection;
    await act(async () => root.render(<Editor presentation={source} />));
    expect(EditorView.findFromDOM(host.querySelector(".cm-content")!)).toBe(view);
    expect(documentSession.open).toHaveBeenCalledTimes(1);
    expect(view.state.selection).toBe(selection);
    expect(view.state.doc.toString()).toBe("# Shared edit");
    await act(async () => delivery.resolve({ status: "ended" }));
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
    expect(apiRef.current?.isLive()).toBe(false);
    expect(() => apiRef.current?.applyTransform((text) => text + " lost")).toThrow("Reconnect");
    expect(view.state.doc.toString()).toBe("# Shared edit");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
